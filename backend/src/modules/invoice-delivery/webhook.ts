import { timingSafeEqual } from 'node:crypto';
import { Router } from 'express';
import { env } from '../../config/env.js';
import { asyncHandler, HttpError } from '../../lib/http.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import { msg91Timestamp, normalizeMsg91Status } from './msg91-status.js';
import { applyProviderDeliveryStatus } from './repository.js';
import { processMsg91InvoiceButtonResponse } from './help-requests.js';
import { handOffSentInvoiceToPaymentSchedule } from '../payment-follow-up/handoff.js';

export const msg91WebhookRouter = Router();

msg91WebhookRouter.post(
  '/whatsapp',
  asyncHandler(async (request, response) => {
    verifyWebhookSecret(request.header('x-msg91-webhook-secret'));
    const payload = isRecord(request.body) ? request.body : { value: request.body };
    const eventType = msg91WebhookEventType(payload);
    const providerMessageId = findString(payload, [
      'message_id',
      'messageId',
      'provider_message_id',
      'uuid',
      'vendorId',
    ]);
    const providerRequestId = findString(payload, ['request_id', 'requestId']);
    const externalEventId = findString(payload, ['event_id', 'eventId']) ??
      (providerMessageId && eventType !== 'unknown'
        ? `${providerMessageId}:${eventType.toLowerCase()}`
        : undefined);
    const client = getSupabaseServerClient();
    const { data: provider } = await client
      .from('provider_integrations')
      .select('id')
      .eq('provider', 'msg91')
      .eq('channel', 'whatsapp')
      .maybeSingle();

    const { data: insertedEvent, error: insertError } = await client
      .from('provider_webhook_events')
      .insert({
        provider_integration_id: provider?.id ?? null,
        provider: 'msg91',
        external_event_id: externalEventId,
        provider_message_id: providerMessageId,
        event_type: eventType,
        payload,
        signature_verified: true,
      })
      .select('id')
      .single();
    let event = insertedEvent;
    if (insertError?.code === '23505') {
      if (!externalEventId) {
        response.status(200).json({ ok: true, duplicate: true });
        return;
      }
      const { data: existingEvent, error: existingEventError } = await client
        .from('provider_webhook_events')
        .select('id,processed_at')
        .eq('provider', 'msg91')
        .eq('external_event_id', externalEventId)
        .single();
      if (existingEventError || !existingEvent) {
        throw new HttpError(500, 'Unable to recover the existing MSG91 webhook');
      }
      if (existingEvent.processed_at) {
        response.status(200).json({ ok: true, duplicate: true });
        return;
      }
      event = { id: existingEvent.id };
    }
    if ((insertError && insertError.code !== '23505') || !event) {
      throw new HttpError(500, 'Unable to store MSG91 webhook');
    }

    try {
      const status = normalizeMsg91Status(eventType);
      if (status) {
        const eventTimestamp = msg91Timestamp(findValue(payload, ['ts', 'statusUpdatedAt']));
        const sentAt = msg91Timestamp(findValue(payload, ['sentTime', 'sent_at', 'sentAt'])) ||
          (status === 'sent' ? eventTimestamp : '');
        const deliveredAt = msg91Timestamp(findValue(payload, ['deliveryTime', 'delivered_at', 'deliveredAt'])) ||
          (status === 'delivered' ? eventTimestamp : '');
        const readAt = msg91Timestamp(findValue(payload, ['readTime', 'read_at', 'readAt'])) ||
          (status === 'read' ? eventTimestamp : '');
        const update = await applyProviderDeliveryStatus({
          ...(providerRequestId ? { providerRequestId } : {}),
          ...(providerMessageId ? { providerMessageId } : {}),
          status,
          ...(sentAt ? { sentAt } : {}),
          ...(deliveredAt ? { deliveredAt } : {}),
          ...(readAt ? { readAt } : {}),
          ...(status === 'failed'
            ? {
                failedAt: eventTimestamp || new Date().toISOString(),
                failureCode: findString(payload, ['metaErrorCode', 'error_code', 'code']) ?? 'msg91_failed',
                failureReason:
                  findString(payload, ['failureReason', 'reason', 'error', 'description']) ??
                  'MSG91 reported delivery failure',
              }
            : {}),
          payload,
        });
        if (
          update.applied &&
          update.jobId &&
          update.sentAt &&
          update.status &&
          ['sent', 'delivered', 'read'].includes(update.status)
        ) {
          await handOffSentInvoiceToPaymentSchedule(update.jobId, update.sentAt);
        }
      }
      await processMsg91InvoiceButtonResponse({
        payload,
        providerIntegrationId: provider?.id ?? null,
        webhookEventId: event.id,
      });
      await client
        .from('provider_webhook_events')
        .update({ processed_at: new Date().toISOString(), processing_error: null })
        .eq('id', event.id);
    } catch (error) {
      await client
        .from('provider_webhook_events')
        .update({ processing_error: error instanceof Error ? error.message : 'Unknown webhook error' })
        .eq('id', event.id);
      throw error;
    }

    response.status(200).json({ ok: true });
  }),
);

export function msg91WebhookEventType(payload: Record<string, unknown>): string {
  return findString(payload, [
    // Webhook (New) uses eventName; the remaining keys support older payloads.
    'eventName',
    'event_name',
    'event_type',
    'event',
    'status',
    'type',
  ]) ?? 'unknown';
}

function verifyWebhookSecret(received: string | undefined): void {
  if (!env.MSG91_WEBHOOK_SECRET) {
    throw new HttpError(503, 'MSG91 webhook secret is not configured');
  }
  const expected = Buffer.from(env.MSG91_WEBHOOK_SECRET);
  const actual = Buffer.from(received ?? '');
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    throw new HttpError(401, 'Invalid MSG91 webhook secret');
  }
}

function findString(value: unknown, keys: string[]): string | undefined {
  const found = findValue(value, keys);
  return typeof found === 'string' && found ? found : undefined;
}

function findValue(value: unknown, keys: string[]): unknown {
  if (Array.isArray(value)) {
    for (const entry of value) {
      const found = findValue(entry, keys);
      if (found !== undefined) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    if (value[key] !== undefined && value[key] !== null) return value[key];
  }
  for (const child of Object.values(value)) {
    const found = findValue(child, keys);
    if (found !== undefined) return found;
  }
  return undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
