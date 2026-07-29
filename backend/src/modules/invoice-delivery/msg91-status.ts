import { env, isMsg91Configured } from '../../config/env.js';
import {
  applyProviderDeliveryStatus,
  listPendingProviderRequestIds,
  type ProviderDeliveryStatus,
} from './repository.js';

const MSG91_WHATSAPP_LOGS_URL = 'https://control.msg91.com/api/v5/report/logs/wa';

type Msg91Log = Record<string, unknown>;

let timer: NodeJS.Timeout | undefined;
let running = false;

export function startMsg91StatusPoller(): () => void {
  if (timer || !env.MSG91_STATUS_POLL_ENABLED || !isMsg91Configured) {
    return stopMsg91StatusPoller;
  }
  timer = setInterval(() => {
    void reconcileMsg91DeliveryStatuses().catch((error) => {
      console.error('MSG91 delivery status reconciliation failed', error instanceof Error ? error.message : error);
    });
  }, env.MSG91_STATUS_POLL_INTERVAL_MS);
  timer.unref();
  void reconcileMsg91DeliveryStatuses().catch((error) => {
    console.error('Initial MSG91 delivery status reconciliation failed', error instanceof Error ? error.message : error);
  });
  return stopMsg91StatusPoller;
}

export function stopMsg91StatusPoller(): void {
  if (timer) clearInterval(timer);
  timer = undefined;
}

export async function reconcileMsg91DeliveryStatuses(): Promise<{
  pending: number;
  matched: number;
  updated: number;
}> {
  if (running || !env.MSG91_STATUS_POLL_ENABLED || !isMsg91Configured) {
    return { pending: 0, matched: 0, updated: 0 };
  }
  running = true;
  try {
    const startedAfter = new Date(Date.now() - 72 * 60 * 60 * 1000).toISOString();
    const pendingIds = await listPendingProviderRequestIds(startedAfter);
    if (pendingIds.length === 0) return { pending: 0, matched: 0, updated: 0 };

    const logs = await fetchMsg91WhatsappLogs();
    const byRequestId = new Map(
      logs
        .map((log) => [text(log.requestId), log] as const)
        .filter(([requestId]) => Boolean(requestId)),
    );
    let matched = 0;
    let updated = 0;
    for (const requestId of pendingIds) {
      const log = byRequestId.get(requestId);
      if (!log) continue;
      const status = normalizeMsg91Status(log.status);
      if (!status) continue;
      matched += 1;
      const applied = await applyProviderDeliveryStatus({
        providerRequestId: requestId,
        ...(text(log.uuid) ? { providerMessageId: text(log.uuid) } : {}),
        status,
        ...(msg91Timestamp(log.sentTime) ? { sentAt: msg91Timestamp(log.sentTime) } : {}),
        ...(msg91Timestamp(log.deliveryTime)
          ? { deliveredAt: msg91Timestamp(log.deliveryTime) }
          : {}),
        ...(msg91Timestamp(log.readTime) ? { readAt: msg91Timestamp(log.readTime) } : {}),
        ...(status === 'failed'
          ? {
              failedAt: msg91Timestamp(log.statusUpdatedAt) || new Date().toISOString(),
              failureCode: text(log.metaErrorCode) || 'msg91_failed',
              failureReason: text(log.failureReason) || 'MSG91 reported delivery failure',
            }
          : {}),
        payload: sanitizeMsg91Report(log),
      });
      if (applied) updated += 1;
    }
    return { pending: pendingIds.length, matched, updated };
  } finally {
    running = false;
  }
}

export async function fetchMsg91WhatsappLogs(now = new Date()): Promise<Msg91Log[]> {
  if (!env.MSG91_AUTHKEY) throw new Error('MSG91 auth key is not configured');
  const url = new URL(MSG91_WHATSAPP_LOGS_URL);
  url.searchParams.set('startDate', dateInIndia(new Date(now.getTime() - 2 * 86_400_000)));
  url.searchParams.set('endDate', dateInIndia(now));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 20_000);
  try {
    const response = await fetch(url, {
      method: 'GET',
      headers: { accept: 'application/json', authkey: env.MSG91_AUTHKEY },
      signal: controller.signal,
    });
    const body = await response.json().catch(() => ({})) as Record<string, unknown>;
    if (!response.ok) throw new Error(`MSG91 logs request failed with HTTP ${response.status}`);
    return Array.isArray(body.data) ? body.data.filter(isRecord) : [];
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      throw new Error('MSG91 logs request timed out');
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function normalizeMsg91Status(value: unknown): ProviderDeliveryStatus | null {
  const normalized = text(value).toLowerCase();
  if (
    normalized.includes('fail') ||
    normalized.includes('reject') ||
    normalized.includes('undeliver') ||
    normalized.includes('expire')
  ) return 'failed';
  if (normalized.includes('read')) return 'read';
  if (normalized.includes('deliver')) return 'delivered';
  if (normalized === 'sent' || normalized.includes('submit')) return 'sent';
  if (normalized.includes('accept') || normalized.includes('process')) return 'accepted';
  return null;
}

export function msg91Timestamp(value: unknown): string {
  const unwrapped = isRecord(value) ? value.value : value;
  const raw = text(unwrapped);
  if (!raw) return '';
  const withOffset = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}:\d{2}$/.test(raw)
    ? `${raw.replace(' ', 'T')}+05:30`
    : raw;
  const parsed = new Date(withOffset);
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString();
}

function sanitizeMsg91Report(log: Msg91Log): Msg91Log {
  const safe = { ...log };
  for (const key of [
    'integratedNumber',
    'customerNumber',
    'content',
    'emailId',
    'accountManagerEmailId',
  ]) delete safe[key];
  return safe;
}

function dateInIndia(value: Date): string {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(value);
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((part) => part.type === type)?.value ?? '';
  return `${get('year')}-${get('month')}-${get('day')}`;
}

function text(value: unknown): string {
  if (value == null) return '';
  if (typeof value === 'object') return '';
  return String(value).trim();
}

function isRecord(value: unknown): value is Msg91Log {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
