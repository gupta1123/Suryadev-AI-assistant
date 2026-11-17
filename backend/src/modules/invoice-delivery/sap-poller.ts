import { randomUUID } from 'node:crypto';
import {
  env,
  isSapPollingConfigured,
  sapAllowedCustomers,
  isSapTestDocumentAllowed,
  whatsappTestRecipients,
  isDashboardCustomerApprovalEnabled,
} from '../../config/env.js';
import {
  claimSapPollingCheckpoint,
  finishSapPollingCheckpoint,
  findBillingDocumentsWithDeliveryJob,
  persistInvoiceAndEnqueue,
} from './repository.js';
import { listCustomerSettings } from '../messaging/repository.js';
import type { CustomerMessagingSetting } from '../messaging/policy.js';
import type { InvoiceSourceSummary } from './invoice-source.js';
import { SapInvoiceSource } from './sap-source.js';
import { processDeliveryQueue } from './worker.js';
import { isWhatsappTemplateApproved } from './msg91-client.js';
import { documentPollBlocker } from '../messaging/guard.js';
import { CREATED_BEFORE_ENABLED } from '../messaging/policy.js';
import { documentDateBlocker } from '../messaging/document-date-policy.js';
import { tmtMaterialBlocker } from '../messaging/tmt-materials.js';
import {
  getBillingDocumentDefinition,
  isTmtDocument,
  SUPPORTED_BILLING_DOCUMENT_TYPES,
} from './document-policy.js';

export type SapPollResult = {
  status: 'completed' | 'skipped';
  examined: number;
  queued: number;
  duplicates: number;
  skipped: number;
  failed: number;
  lastBillingDocument?: string;
};

// A few invoices are read from SAP at once; more would risk SAP throttling.
const POLL_CONCURRENCY = 4;

let timer: NodeJS.Timeout | undefined;
let running = false;
const pollerName = `sap-invoice-poller-${randomUUID().slice(0, 8)}`;

export function startSapInvoicePoller(): () => void {
  if (timer || !isSapPollingConfigured) return stopSapInvoicePoller;
  timer = setInterval(() => {
    void pollSapInvoices().catch((error) => {
      console.error('SAP invoice poll failed', error instanceof Error ? error.message : error);
    });
  }, env.SAP_POLL_INTERVAL_MS);
  timer.unref();
  void pollSapInvoices().catch((error) => {
    console.error('Initial SAP invoice poll failed', error instanceof Error ? error.message : error);
  });
  return stopSapInvoicePoller;
}

export function stopSapInvoicePoller(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export async function pollSapInvoices(): Promise<SapPollResult> {
  if (!isSapPollingConfigured) {
    return { status: 'skipped', examined: 0, queued: 0, duplicates: 0, skipped: 0, failed: 0 };
  }
  if (running) {
    return { status: 'skipped', examined: 0, queued: 0, duplicates: 0, skipped: 0, failed: 0 };
  }

  running = true;
  let checkpoint: Awaited<ReturnType<typeof claimSapPollingCheckpoint>> = null;
  const result: SapPollResult = {
    status: 'completed',
    examined: 0,
    queued: 0,
    duplicates: 0,
    skipped: 0,
    failed: 0,
  };
  const errors: string[] = [];

  try {
    checkpoint = await claimSapPollingCheckpoint(pollerName);
    if (!checkpoint) return { ...result, status: 'skipped' };

    const source = new SapInvoiceSource();
    const invoices = await source.list();
    result.examined = invoices.length;
    const templateApprovals = new Map(
      await Promise.all(
        SUPPORTED_BILLING_DOCUMENT_TYPES.map(async (type) => {
          const definition = getBillingDocumentDefinition(type)!;
          return [
            type,
            await isWhatsappTemplateApproved(
              definition.templateName,
              env.MSG91_TEMPLATE_LANGUAGE,
            ),
          ] as const;
        }),
      ),
    );

    // Step 1: invoices already queued, sent or failed need no heavy SAP read at all.
    const handled = await findBillingDocumentsWithDeliveryJob(invoices.map((invoice) => invoice.billingDocument));
    const pending = invoices.filter((invoice) => !handled.has(invoice.billingDocument));
    result.duplicates += invoices.length - pending.length;
    const settings = new Map((await listCustomerSettings()).map((setting) => [setting.sapCustomerNumber, setting]));

    const processInvoice = async (invoice: (typeof invoices)[number]): Promise<void> => {
      result.lastBillingDocument = invoice.billingDocument;
      try {
        const definition = getBillingDocumentDefinition(invoice.billingDocumentType);
        if (!definition || !templateApprovals.get(definition.type)) {
          result.skipped += 1;
          errors.push(
            `${invoice.billingDocument}: WhatsApp template ${definition?.templateName ?? 'unknown'} is not approved`,
          );
          return;
        }
        // Step 2: cheap checks from the list data (customer enabled, created after enabling, dates).
        const early = earlyBlocker(invoice, invoice.customerNumber ? settings.get(invoice.customerNumber) : undefined);
        if (early) {
          result.skipped += 1;
          return;
        }
        // Step 3: product settings from the line items alone, before the PDF and phone reads.
        const itemReason = await tmtMaterialBlocker(await source.readItems(invoice.id));
        if (itemReason) {
          result.skipped += 1;
          errors.push(`${invoice.billingDocument}: ${itemReason}`);
          return;
        }
        // Everything below is the unchanged full check, run only for invoices that got this far.
        const candidate = await source.get(invoice.id);
        const reason = automaticDeliveryBlocker(candidate) ?? await tmtMaterialBlocker(candidate.items) ?? await documentPollBlocker({
          customerNumber: candidate.customer.customerNumber,
          livePhone: candidate.contact.normalizedValue,
          creationDateTime: candidate.creationDateTime ?? null,
          documentDate: candidate.billingDocumentDate,
        });
        if (reason) {
          result.skipped += 1;
          // Routine: an older document that earlier deliveries already handled. Counted as
          // skipped, but not reported as a polling error in Settings.
          if (reason !== CREATED_BEFORE_ENABLED) errors.push(`${candidate.billingDocument}: ${reason}`);
          return;
        }
        const persisted = await persistInvoiceAndEnqueue(
          candidate,
          candidate.contact.normalizedValue,
          { source: 'sap', triggerType: 'scheduled' },
        );
        if (persisted.duplicate) result.duplicates += 1;
        else result.queued += 1;
      } catch (error) {
        result.failed += 1;
        errors.push(`${invoice.billingDocument}: ${errorMessage(error)}`);
      }
    };
    for (let start = 0; start < pending.length; start += POLL_CONCURRENCY) {
      await Promise.all(pending.slice(start, start + POLL_CONCURRENCY).map(processInvoice));
    }

    const watermark = invoices.length
      ? new Date().toISOString()
      : checkpoint.watermark_at ?? `${env.SAP_POLL_START_DATE}T00:00:00.000Z`;
    await finishSapPollingCheckpoint({
      checkpointId: checkpoint.id,
      status: result.failed > 0 ? 'failed' : 'succeeded',
      recordsProcessed: result.examined,
      watermarkAt: watermark,
      cursorValue: result.lastBillingDocument ?? 'no-new-invoices',
      ...(errors.length ? { error: errors.slice(0, 10).join('; ') } : {}),
    });

    if (result.queued > 0) await processDeliveryQueue();
    return result;
  } catch (error) {
    if (checkpoint) {
      await finishSapPollingCheckpoint({
        checkpointId: checkpoint.id,
        status: 'failed',
        recordsProcessed: result.examined,
        cursorValue: result.lastBillingDocument ?? 'poll-failed',
        error: errorMessage(error),
      }).catch(() => undefined);
    }
    throw error;
  } finally {
    running = false;
  }
}

/**
 * Cheap pre-check using only data from the SAP list call. It only ever skips an invoice
 * earlier; every invoice that passes still goes through the full unchanged checks.
 */
export function earlyBlocker(
  invoice: Pick<InvoiceSourceSummary, 'billingDocumentDate' | 'creationDateTime'>,
  setting: CustomerMessagingSetting | undefined,
): string | null {
  // Only the dashboard approval mode keeps customer approvals in Settings; other modes use fixed lists.
  if (!isDashboardCustomerApprovalEnabled()) return null;
  if (!setting?.enabled) return 'customer is not enabled in Settings';
  if (!invoice.billingDocumentDate || !invoice.creationDateTime) return null; // not enough data here; the full check decides
  return documentDateBlocker(
    { documentDate: invoice.billingDocumentDate, documentCreatedAt: invoice.creationDateTime },
    setting.enabledAt,
  );
}

export function automaticDeliveryBlocker(
  candidate: Awaited<ReturnType<SapInvoiceSource['get']>>,
): string | null {
  const definition = getBillingDocumentDefinition(candidate.billingDocumentType);
  if (!definition) return 'billing document type is not supported';
  const dateRefusal = documentDateBlocker({ documentDate: candidate.billingDocumentDate, documentCreatedAt: candidate.creationDateTime });
  if (dateRefusal) return dateRefusal;
  if (!isSapTestDocumentAllowed(candidate.billingDocument, candidate.creationDateTime)) {
    return 'billing document is outside the test document boundary';
  }
  if (!isDashboardCustomerApprovalEnabled() && !sapAllowedCustomers.has(candidate.customer.customerNumber)) {
    return 'customer is outside the SAP allowlist';
  }
  if ((candidate.creationDateTime ?? `${candidate.billingDocumentDate}T00:00:00.000Z`).slice(0, 10) < env.SAP_POLL_START_DATE) {
    return 'invoice was created before the polling start date';
  }
  if (candidate.isCancelled && definition.type !== 'S1') {
    return 'billing document is a cancelled original; waiting for its S1 cancellation document';
  }
  if (env.TMT_MATERIAL_CONTROL_MODE !== 'dashboard' && !isTmtDocument(candidate)) return 'billing document does not contain a configured TMT material';
  if (!candidate.pdf.base64) return 'billing document PDF is not available';
  if (!/^[1-9]\d{7,14}$/.test(candidate.contact.normalizedValue)) {
    return 'customer WhatsApp number is invalid';
  }
  if (
    env.DELIVERY_MODE === 'test' &&
    !isDashboardCustomerApprovalEnabled() &&
    !whatsappTestRecipients.has(candidate.contact.normalizedValue)
  ) {
    return 'customer WhatsApp number is outside the test allowlist';
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown SAP polling error';
}
