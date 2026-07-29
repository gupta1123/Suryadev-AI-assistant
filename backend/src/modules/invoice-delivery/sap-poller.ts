import { randomUUID } from 'node:crypto';
import {
  env,
  isSapPollingConfigured,
  sapAllowedCustomers,
  whatsappTestRecipients,
} from '../../config/env.js';
import {
  claimSapPollingCheckpoint,
  finishSapPollingCheckpoint,
  persistInvoiceAndEnqueue,
} from './repository.js';
import { SapInvoiceSource } from './sap-source.js';
import { processDeliveryQueue } from './worker.js';

export type SapPollResult = {
  status: 'completed' | 'skipped';
  examined: number;
  queued: number;
  duplicates: number;
  skipped: number;
  failed: number;
  lastBillingDocument?: string;
};

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

    for (const invoice of invoices) {
      result.lastBillingDocument = invoice.billingDocument;
      try {
        const candidate = await source.get(invoice.id);
        const reason = automaticDeliveryBlocker(candidate);
        if (reason) {
          result.skipped += 1;
          errors.push(`${candidate.billingDocument}: ${reason}`);
          continue;
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

function automaticDeliveryBlocker(
  candidate: Awaited<ReturnType<SapInvoiceSource['get']>>,
): string | null {
  if (!sapAllowedCustomers.has(candidate.customer.customerNumber)) {
    return 'customer is outside the SAP allowlist';
  }
  if ((candidate.creationDateTime ?? `${candidate.billingDocumentDate}T00:00:00.000Z`).slice(0, 10) < env.SAP_POLL_START_DATE) {
    return 'invoice was created before the polling start date';
  }
  if (candidate.isCancelled) return 'invoice is cancelled';
  if (!candidate.pdf.base64) return 'invoice PDF is not available';
  if (!/^[1-9]\d{7,14}$/.test(candidate.contact.normalizedValue)) {
    return 'customer WhatsApp number is invalid';
  }
  if (
    env.DELIVERY_MODE === 'test' &&
    !whatsappTestRecipients.has(candidate.contact.normalizedValue)
  ) {
    return 'customer WhatsApp number is outside the test allowlist';
  }
  return null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'Unknown SAP polling error';
}
