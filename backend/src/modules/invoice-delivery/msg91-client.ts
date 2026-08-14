import { digitsOnly, env } from '../../config/env.js';
import type { Msg91TemplateInput } from './domain.js';

const MSG91_TEMPLATE_URL =
  'https://control.msg91.com/api/v5/whatsapp/whatsapp-outbound-message/bulk/';
const MSG91_GET_TEMPLATE_URL =
  'https://control.msg91.com/api/v5/whatsapp/get-template-client/';

export type Msg91SendResult = {
  ok: boolean;
  statusCode: number;
  body: unknown;
  providerRequestId?: string;
  providerMessageId?: string;
  ambiguous: boolean;
};

export type Msg91PaymentReminderInput = {
  recipient: string;
  customerName: string;
  outstandingAmount: string;
  billingDocument: string;
  billingDocumentDate: string;
  teamName: string;
};

export async function isPaymentReminderTemplateApproved(
  timeoutMs = 20_000,
): Promise<boolean> {
  if (!env.MSG91_AUTHKEY || !digitsOnly(env.MSG91_INTEGRATED_NUMBER)) return false;
  const url = new URL(`${MSG91_GET_TEMPLATE_URL}${digitsOnly(env.MSG91_INTEGRATED_NUMBER)}`);
  url.searchParams.set('template_name', env.MSG91_PAYMENT_TEMPLATE_NAME);
  url.searchParams.set('template_status', 'approved');
  url.searchParams.set('template_language', env.MSG91_PAYMENT_TEMPLATE_LANGUAGE);
  url.searchParams.set('pagination', 'true');
  url.searchParams.set('page_size', '10');
  url.searchParams.set('page_num', '1');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: {
        accept: 'application/json',
        authkey: env.MSG91_AUTHKEY,
        'content-type': 'text/plain',
      },
      signal: controller.signal,
    });
    if (!response.ok) return false;
    const body = await response.json().catch(() => ({}));
    return findApprovedTemplate(body);
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') return false;
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function buildMsg91InvoicePayload(input: Msg91TemplateInput): Record<string, unknown> {
  return {
    integrated_number: digitsOnly(env.MSG91_INTEGRATED_NUMBER),
    content_type: 'template',
    payload: {
      type: 'template',
      template: {
        name: env.MSG91_TEMPLATE_NAME,
        language: {
          code: env.MSG91_TEMPLATE_LANGUAGE,
          policy: 'deterministic',
        },
        to_and_components: [
          {
            to: [digitsOnly(input.recipient)],
            components: {
              header_1: {
                type: 'document',
                value: input.documentUrl,
                filename: input.documentFileName,
              },
              body_var_1: { type: 'text', value: input.customerName },
              body_var_2: { type: 'text', value: input.billingDocument },
              body_var_3: { type: 'text', value: input.billingDocumentDate },
              body_var_4: { type: 'text', value: input.formattedAmount },
              body_var_5: { type: 'text', value: input.teamName },
            },
          },
        ],
      },
    },
  };
}

export function buildMsg91PaymentReminderPayload(
  input: Msg91PaymentReminderInput,
): Record<string, unknown> {
  return {
    integrated_number: digitsOnly(env.MSG91_INTEGRATED_NUMBER),
    content_type: 'template',
    payload: {
      type: 'template',
      template: {
        name: env.MSG91_PAYMENT_TEMPLATE_NAME,
        language: {
          code: env.MSG91_PAYMENT_TEMPLATE_LANGUAGE,
          policy: 'deterministic',
        },
        to_and_components: [
          {
            to: [digitsOnly(input.recipient)],
            components: {
              body_1: { type: 'text', value: input.customerName },
              body_2: { type: 'text', value: input.outstandingAmount },
              body_3: { type: 'text', value: input.billingDocument },
              body_4: { type: 'text', value: input.billingDocumentDate },
              body_5: { type: 'text', value: input.teamName },
            },
          },
        ],
      },
    },
  };
}

export async function sendInvoiceTemplate(
  input: Msg91TemplateInput,
  timeoutMs = 20_000,
): Promise<Msg91SendResult> {
  if (!env.MSG91_AUTHKEY || !digitsOnly(env.MSG91_INTEGRATED_NUMBER)) {
    throw new Error('MSG91 is not configured');
  }
  if (!env.MSG91_SEND_ENABLED) {
    throw new Error('MSG91 real sending is disabled');
  }

  return sendTemplatePayload(buildMsg91InvoicePayload(input), timeoutMs);
}

export async function sendPaymentReminderTemplate(
  input: Msg91PaymentReminderInput,
  timeoutMs = 20_000,
): Promise<Msg91SendResult> {
  if (!env.MSG91_AUTHKEY || !digitsOnly(env.MSG91_INTEGRATED_NUMBER)) {
    throw new Error('MSG91 is not configured');
  }
  if (!env.MSG91_SEND_ENABLED || !env.PAYMENT_FOLLOW_UP_SEND_ENABLED) {
    throw new Error('Payment reminder sending is disabled');
  }
  return sendTemplatePayload(buildMsg91PaymentReminderPayload(input), timeoutMs);
}

async function sendTemplatePayload(
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<Msg91SendResult> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(MSG91_TEMPLATE_URL, {
      method: 'POST',
      headers: {
        accept: 'application/json',
        authkey: env.MSG91_AUTHKEY,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const body = await readResponseBody(response);
    const bodyRecord = isRecord(body) ? body : undefined;
    const providerReportedError =
      bodyRecord?.hasError === true ||
      bodyRecord?.type === 'error' ||
      String(bodyRecord?.status ?? '').toLowerCase() === 'error';

    return {
      ok: response.ok && !providerReportedError,
      statusCode: response.status,
      body,
      ...findProviderIdentifiers(body),
      ambiguous: false,
    };
  } catch (error) {
    if (error instanceof DOMException && error.name === 'AbortError') {
      return {
        ok: false,
        statusCode: 0,
        body: { error: 'MSG91 request timed out; delivery outcome is unknown' },
        ambiguous: true,
      };
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

export function sanitizeMsg91Payload(payload: Record<string, unknown>): Record<string, unknown> {
  const copy = structuredClone(payload);
  const wrapper = copy.payload as Record<string, unknown> | undefined;
  const template = wrapper?.template as Record<string, unknown> | undefined;
  const recipients = template?.to_and_components;
  if (!Array.isArray(recipients)) return copy;

  for (const entry of recipients) {
    if (!isRecord(entry)) continue;
    if (Array.isArray(entry.to)) entry.to = entry.to.map(() => '[redacted-phone]');
    const components = entry.components;
    if (!isRecord(components)) continue;
    const header = components.header_1;
    if (isRecord(header) && typeof header.value === 'string') {
      header.value = '[redacted-signed-url]';
    }
  }
  return copy;
}

async function readResponseBody(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!text) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 2_000) };
  }
}

function findProviderIdentifiers(value: unknown): {
  providerRequestId?: string;
  providerMessageId?: string;
} {
  const requestId = findStringByKeys(value, ['request_id', 'requestId', 'uuid']);
  const messageId = findStringByKeys(value, [
    'message_id',
    'messageId',
    'provider_message_id',
  ]);
  return {
    ...(requestId ? { providerRequestId: requestId } : {}),
    ...(messageId ? { providerMessageId: messageId } : {}),
  };
}

function findStringByKeys(value: unknown, keys: string[]): string | undefined {
  if (Array.isArray(value)) {
    for (const item of value) {
      const found = findStringByKeys(item, keys);
      if (found) return found;
    }
    return undefined;
  }
  if (!isRecord(value)) return undefined;
  for (const key of keys) {
    const candidate = value[key];
    if (typeof candidate === 'string' && candidate) return candidate;
  }
  for (const nested of Object.values(value)) {
    const found = findStringByKeys(nested, keys);
    if (found) return found;
  }
  return undefined;
}

function findApprovedTemplate(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(findApprovedTemplate);
  if (!isRecord(value)) return false;
  if (
    value.name === env.MSG91_PAYMENT_TEMPLATE_NAME &&
    value.language === env.MSG91_PAYMENT_TEMPLATE_LANGUAGE &&
    String(value.status ?? '').toLowerCase() === 'approved'
  ) return true;
  return Object.values(value).some(findApprovedTemplate);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
