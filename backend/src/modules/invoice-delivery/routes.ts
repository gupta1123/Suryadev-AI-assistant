import { randomUUID } from 'node:crypto';
import { Router } from 'express';
import { z } from 'zod';
import {
  defaultWhatsappTestRecipient,
  env,
  isMsg91Configured,
  isSapConfigured,
  isSapPollingConfigured,
  isSupabaseServiceConfigured,
  sapAllowedCustomers,
  sapTmtMaterialGroups,
  sapTmtMaterialIds,
  sapTmtMaterialPrefixes,
  whatsappTestRecipients,
} from '../../config/env.js';
import { asyncHandler, HttpError } from '../../lib/http.js';
import {
  type AuthenticatedRequest,
  requireAdmin,
} from '../../middleware/auth.js';
import { getInvoiceSource } from './invoice-source.js';
import { buildInvoicePreview, maskPhone } from './policy.js';
import {
  getBillingDocumentDefinition,
  SUPPORTED_BILLING_DOCUMENT_TYPES,
} from './document-policy.js';
import {
  getDeliveryJob,
  getSapPollingStatus,
  listDeliveryJobs,
  listDeliveryJobsPage,
  persistInvoiceAndEnqueue,
  retryDeliveryJob,
} from './repository.js';
import { InvoiceSimulator } from './simulator.js';
import {
  isPaymentReminderTemplateApproved,
  isWhatsappTemplateApproved,
} from './msg91-client.js';
import { buildSimulatedPaymentPreview } from '../payment-follow-up/policy.js';
import { preparePaymentEndToEndTest } from '../payment-follow-up/repository.js';
import { pollSapInvoices } from './sap-poller.js';
import { processDeliveryQueue } from './worker.js';
import {
  listInvoiceHelpRequests,
  listInvoiceHelpRequestsPage,
  updateInvoiceHelpRequestStatus,
} from './help-requests.js';

const previewSchema = z.object({
  fixtureId: z.string().min(1),
  recipient: z.string().default(''),
});

const simulationSchema = z.object({
  documentType: z.enum(SUPPORTED_BILLING_DOCUMENT_TYPES).default('F2'),
});

const listSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  beforeId: z.coerce.number().int().positive().optional(),
  paginated: z.literal('true').optional(),
});

const helpRequestListSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(10),
  beforeId: z.coerce.number().int().positive().optional(),
  status: z.enum(['open', 'in_progress', 'resolved']).optional(),
  paginated: z.literal('true').optional(),
});

const jobIdSchema = z.coerce.number().int().positive();
const helpRequestIdSchema = z.coerce.number().int().positive();
const helpRequestStatusSchema = z.object({
  status: z.enum(['open', 'in_progress', 'resolved']),
});
const source = getInvoiceSource();
const simulator = new InvoiceSimulator();

export const invoiceDeliveryRouter = Router();

invoiceDeliveryRouter.use((request, response, next) => {
  void requireAdmin(request, response, next);
});

invoiceDeliveryRouter.get('/config', (_request, response) => {
  const simulationBlockers = getSimulationBlockers();
  response.json({
    data: {
      invoiceSource: env.INVOICE_SOURCE,
      deliveryMode: env.DELIVERY_MODE,
      supabaseServiceConfigured: isSupabaseServiceConfigured,
      msg91Configured: isMsg91Configured,
      sendEnabled: env.MSG91_SEND_ENABLED,
      msg91WebhookConfigured: Boolean(env.MSG91_WEBHOOK_SECRET),
      msg91StatusPollingEnabled: env.MSG91_STATUS_POLL_ENABLED,
      templateName: env.MSG91_TEMPLATE_NAME,
      templateLanguage: env.MSG91_TEMPLATE_LANGUAGE,
      billingDocumentTypes: SUPPORTED_BILLING_DOCUMENT_TYPES.map((type) => {
        const definition = getBillingDocumentDefinition(type)!;
        return {
          type,
          kind: definition.kind,
          label: definition.label,
          templateName: definition.templateName,
        };
      }),
      testRecipients: [...whatsappTestRecipients].map(maskPhone),
      defaultTestRecipient: maskPhone(defaultWhatsappTestRecipient),
      simulationReady: simulationBlockers.length === 0,
      simulationBlockers,
      sapConfigured: isSapConfigured,
      sapPollingEnabled: env.SAP_POLL_ENABLED,
      sapPollingReady: isSapPollingConfigured,
      sapPollIntervalMs: env.SAP_POLL_INTERVAL_MS,
      sapPollStartDate: env.SAP_POLL_START_DATE,
      sapPollStartAt: env.SAP_POLL_START_AT || null,
      sapTestBoundaryMode: env.DELIVERY_MODE === 'test'
        ? (env.SAP_ALLOWED_BILLING_DOCUMENTS ? 'exact_documents' : 'created_after')
        : null,
      sapAllowedCustomers: [...sapAllowedCustomers],
      tmtMaterialIds: [...sapTmtMaterialIds],
      tmtMaterialPrefixes: [...sapTmtMaterialPrefixes],
      tmtMaterialGroups: [...sapTmtMaterialGroups],
    },
  });
});

invoiceDeliveryRouter.get(
  '/template-status',
  asyncHandler(async (_request, response) => {
    const templates = await Promise.all(
      SUPPORTED_BILLING_DOCUMENT_TYPES.map(async (type) => {
        const definition = getBillingDocumentDefinition(type)!;
        const approved = await isWhatsappTemplateApproved(
          definition.templateName,
          env.MSG91_TEMPLATE_LANGUAGE,
        );
        return {
          type,
          kind: definition.kind,
          label: definition.label,
          templateName: definition.templateName,
          language: env.MSG91_TEMPLATE_LANGUAGE,
          approved,
        };
      }),
    );
    response.json({
      data: {
        templates,
        allApproved: templates.every((template) => template.approved),
        checkedAt: new Date().toISOString(),
      },
    });
  }),
);

invoiceDeliveryRouter.get(
  '/polling-status',
  asyncHandler(async (_request, response) => {
    response.json({ data: await getSapPollingStatus() });
  }),
);

invoiceDeliveryRouter.post(
  '/poll-now',
  asyncHandler(async (_request, response) => {
    if (!isSapPollingConfigured) {
      throw new HttpError(409, 'Live SAP polling is not fully configured');
    }
    response.json({ data: await pollSapInvoices() });
  }),
);

invoiceDeliveryRouter.post(
  '/simulate',
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const input = simulationSchema.parse(request.body ?? {});
    const configurationBlockers = getSimulationBlockers();
    if (configurationBlockers.length > 0) {
      throw new HttpError(
        409,
        'Sample billing document simulation is not ready',
        configurationBlockers.map((label) => ({ label })),
      );
    }

    const candidate = await simulator.create(
      new Date(),
      defaultWhatsappTestRecipient,
      input.documentType,
    );
    const preview = await buildApprovedInvoicePreview(
      candidate,
      defaultWhatsappTestRecipient,
    );
    if (!preview.sendAllowed) {
      throw new HttpError(
        409,
        'Sample billing document simulation preflight failed',
        preview.validations.filter((item) => item.blocking && !item.passed),
      );
    }

    const paymentCycleId = env.PAYMENT_SIMULATION_AUTO_FOLLOW_UP && input.documentType === 'F2'
      ? `simulated-invoice-${candidate.billingDocument}-${randomUUID()}`
      : '';
    if (paymentCycleId) {
      const paymentPreview = buildSimulatedPaymentPreview(
        candidate,
        await isPaymentReminderTemplateApproved(),
        preview.actualRecipient,
      );
      if (!paymentPreview.sendAllowed) {
        throw new HttpError(
          409,
          'Automatic payment follow-up preflight failed',
          paymentPreview.validations.filter((item) => item.blocking && !item.passed),
        );
      }
      await preparePaymentEndToEndTest(paymentPreview, paymentCycleId, request.auth?.userId);
    }

    const job = await persistInvoiceAndEnqueue(
      candidate,
      preview.actualRecipient,
      {
        source: env.INVOICE_SOURCE,
        triggerType: 'manual',
        startedBy: request.auth?.userId,
        ...(paymentCycleId
          ? {
              metadata: {
                controlled_test: true,
                payment_e2e_test: true,
                payment_simulation_test: true,
                payment_test_cycle_id: paymentCycleId,
                handoff: 'invoice_sent_to_payment_schedule',
              },
            }
          : {}),
      },
    );
    setImmediate(() => {
      void processDeliveryQueue();
    });

    response.status(job.duplicate ? 200 : 202).json({
      data: {
        ...job,
        billingDocument: candidate.billingDocument,
        billingDocumentType: input.documentType,
        customerName: candidate.customer.displayName,
        amount: candidate.totalGrossAmount,
        currency: candidate.currency,
        maskedRecipient: preview.maskedRecipient,
        pdfFileName: candidate.pdf.fileName,
        paymentFollowUpAutomated: Boolean(paymentCycleId),
      },
    });
  }),
);

invoiceDeliveryRouter.get(
  '/fixtures',
  asyncHandler(async (_request, response) => {
    if (env.INVOICE_SOURCE !== 'fixture') {
      throw new HttpError(409, 'Fixture endpoints are disabled');
    }
    response.json({ data: await source.list() });
  }),
);

invoiceDeliveryRouter.post(
  '/preview',
  asyncHandler(async (request, response) => {
    const input = previewSchema.parse(request.body);
    const candidate = await source.get(input.fixtureId);
    response.json({ data: await buildApprovedInvoicePreview(candidate, input.recipient) });
  }),
);

function getSimulationBlockers(): string[] {
  const blockers: string[] = [];
  if (env.INVOICE_SOURCE !== 'fixture') {
    blockers.push('Use fixture mode so the simulator never calls SAP');
  }
  if (env.DELIVERY_MODE !== 'test') {
    blockers.push('Use test delivery mode for the controlled simulation');
  }
  if (!/^[1-9]\d{7,14}$/.test(defaultWhatsappTestRecipient)) {
    blockers.push('Configure one valid WHATSAPP_DEFAULT_TEST_RECIPIENT with country code');
  }
  if (!isSupabaseServiceConfigured) {
    blockers.push('Configure the backend Supabase service-role credentials');
  }
  if (!isMsg91Configured) {
    blockers.push('Configure the MSG91 auth key and integrated WhatsApp number');
  }
  if (!env.MSG91_SEND_ENABLED) {
    blockers.push('Enable controlled MSG91 sending');
  }
  return blockers;
}

async function buildApprovedInvoicePreview(
  candidate: Awaited<ReturnType<typeof source.get>>,
  recipient: string,
) {
  const preview = buildInvoicePreview(candidate, recipient);
  const definition = getBillingDocumentDefinition(candidate.billingDocumentType);
  const approved = Boolean(
    definition &&
      await isWhatsappTemplateApproved(
        definition.templateName,
        env.MSG91_TEMPLATE_LANGUAGE,
      ),
  );
  const validations = [
    ...preview.validations,
    {
      code: 'template_approved',
      label: definition
        ? `WhatsApp template ${definition.templateName} is approved`
        : 'WhatsApp template is approved',
      passed: approved,
      blocking: true,
    },
  ];
  return {
    ...preview,
    validations,
    sendAllowed: validations.every((item) => !item.blocking || item.passed),
  };
}

invoiceDeliveryRouter.post(
  '/send',
  asyncHandler(async (request: AuthenticatedRequest, response) => {
    const input = previewSchema.parse(request.body);
    const candidate = await source.get(input.fixtureId);
    const preview = await buildApprovedInvoicePreview(candidate, input.recipient);
    if (!preview.sendAllowed) {
      throw new HttpError(
        409,
        'Invoice delivery preflight failed',
        preview.validations.filter((item) => item.blocking && !item.passed),
      );
    }

    const job = await persistInvoiceAndEnqueue(
      candidate,
      preview.actualRecipient,
      {
        source: env.INVOICE_SOURCE,
        triggerType: 'manual',
        startedBy: request.auth?.userId,
      },
    );
    setImmediate(() => {
      void processDeliveryQueue();
    });
    response.status(job.duplicate ? 200 : 202).json({ data: job });
  }),
);

invoiceDeliveryRouter.get(
  '/jobs',
  asyncHandler(async (request, response) => {
    const input = listSchema.parse(request.query);
    if (!isSupabaseServiceConfigured) {
      response.json({ data: [] });
      return;
    }
    response.json({
      data: input.paginated
        ? await listDeliveryJobsPage(input.limit, input.beforeId)
        : await listDeliveryJobs(input.limit, input.beforeId),
    });
  }),
);

invoiceDeliveryRouter.get(
  '/help-requests',
  asyncHandler(async (request, response) => {
    const input = helpRequestListSchema.parse(request.query);
    response.json({
      data: input.paginated
        ? await listInvoiceHelpRequestsPage(input)
        : await listInvoiceHelpRequests(input.status),
    });
  }),
);

invoiceDeliveryRouter.patch(
  '/help-requests/:helpRequestId',
  asyncHandler(async (request, response) => {
    const id = helpRequestIdSchema.parse(request.params.helpRequestId);
    const { status } = helpRequestStatusSchema.parse(request.body);
    await updateInvoiceHelpRequestStatus(id, status);
    response.json({ data: { id, status } });
  }),
);

invoiceDeliveryRouter.get(
  '/jobs/:jobId',
  asyncHandler(async (request, response) => {
    const jobId = jobIdSchema.parse(request.params.jobId);
    response.json({ data: await getDeliveryJob(jobId) });
  }),
);

invoiceDeliveryRouter.post(
  '/jobs/:jobId/retry',
  asyncHandler(async (request, response) => {
    const jobId = jobIdSchema.parse(request.params.jobId);
    await retryDeliveryJob(jobId);
    setImmediate(() => {
      void processDeliveryQueue();
    });
    response.status(202).json({ data: { jobId, status: 'queued' } });
  }),
);
