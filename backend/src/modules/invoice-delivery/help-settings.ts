import { z } from 'zod';
import {
  digitsOnly,
  helpRequestAlertRecipient,
} from '../../config/env.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import { formatPhone } from './policy.js';

const CACHE_MS = 10_000;

export const helpRequestAlertSettingsSchema = z.object({
  recipient: z.string().trim().min(1).transform(normalizeHelpRequestRecipient).refine(
    (value) => /^[1-9]\d{7,14}$/.test(value),
    'Enter a valid WhatsApp number with country code',
  ),
});

export type HelpRequestAlertSettings = {
  recipient: string;
  formattedRecipient: string;
  source: 'saved' | 'server_default';
  updatedAt: string | null;
};

let cached: { value: HelpRequestAlertSettings; loadedAt: number } | undefined;

export function defaultHelpRequestAlertSettings(): HelpRequestAlertSettings {
  return {
    recipient: helpRequestAlertRecipient,
    formattedRecipient: formatPhone(helpRequestAlertRecipient),
    source: 'server_default',
    updatedAt: null,
  };
}

export async function getHelpRequestAlertSettings(): Promise<HelpRequestAlertSettings> {
  if (cached && Date.now() - cached.loadedAt < CACHE_MS) return cached.value;
  const { data, error } = await getSupabaseServerClient()
    .from('system_settings')
    .select('settings')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error(`Unable to load Need Help settings: ${error.message}`);
  const value = parseStoredHelpRequestAlertSettings(
    isRecord(data?.settings) ? data.settings.help_request_alerts : undefined,
  );
  cached = { value, loadedAt: Date.now() };
  return value;
}

export function parseStoredHelpRequestAlertSettings(
  stored: unknown,
): HelpRequestAlertSettings {
  const fallback = defaultHelpRequestAlertSettings();
  if (!isRecord(stored)) return fallback;
  const parsed = helpRequestAlertSettingsSchema.safeParse(stored);
  if (!parsed.success) return fallback;
  return {
    recipient: parsed.data.recipient,
    formattedRecipient: formatPhone(parsed.data.recipient),
    source: 'saved',
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
  };
}

export async function saveHelpRequestAlertSettings(
  input: unknown,
  updatedBy?: { id: string; username: string },
): Promise<HelpRequestAlertSettings> {
  const next = helpRequestAlertSettingsSchema.parse(input);
  const client = getSupabaseServerClient();
  const { data: row, error: loadError } = await client
    .from('system_settings')
    .select('settings')
    .eq('id', 1)
    .single();
  if (loadError || !row) {
    throw new Error(`Unable to load system settings: ${loadError?.message ?? 'Settings row not found'}`);
  }
  const settings = isRecord(row.settings) ? row.settings : {};
  const before = parseStoredHelpRequestAlertSettings(settings.help_request_alerts);
  const updatedAt = new Date().toISOString();
  const stored = {
    recipient: next.recipient,
    updatedAt,
    updatedBy: updatedBy?.username ?? null,
  };
  const { error } = await client
    .from('system_settings')
    .update({
      settings: { ...settings, help_request_alerts: stored },
      updated_at: updatedAt,
    })
    .eq('id', 1);
  if (error) throw new Error(`Unable to save Need Help settings: ${error.message}`);
  const { error: auditError } = await client.from('audit_logs').insert({
    actor_type: 'user',
    actor_user_id: auditUserId(updatedBy?.id),
    action: 'help_request_alert_recipient_updated',
    entity_type: 'system_settings',
    entity_id: '1',
    before_data: { recipient: before.recipient },
    after_data: { recipient: next.recipient },
    metadata: { username: updatedBy?.username ?? null },
  });
  if (auditError) throw new Error(`Unable to audit Need Help settings: ${auditError.message}`);
  cached = undefined;
  return {
    recipient: next.recipient,
    formattedRecipient: formatPhone(next.recipient),
    source: 'saved',
    updatedAt,
  };
}

export function normalizeHelpRequestRecipient(value: string): string {
  const digits = digitsOnly(value);
  if (/^[6-9]\d{9}$/.test(digits)) return `91${digits}`;
  if (/^0[6-9]\d{9}$/.test(digits)) return `91${digits.slice(1)}`;
  return digits;
}

function auditUserId(userId?: string): string | null {
  return userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
