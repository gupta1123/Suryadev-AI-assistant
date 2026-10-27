import { z } from 'zod';
import { updateSettingsSection } from '../../lib/settings-store.js';
import { env } from '../../config/env.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';

// Admins edit reminder timing from Settings. The values live in the single
// system_settings row under settings.payment_reminders; anything not saved there
// falls back to the server environment.
const MIN_DELAY_SECONDS = 10;
const MAX_DELAY_SECONDS = 30 * 86_400;
const CACHE_MS = 10_000;

export const reminderSettingsSchema = z.object({
  dueDays: z.coerce.number().int().min(1).max(90),
  firstReminderDelaySeconds: z.coerce.number().int().min(MIN_DELAY_SECONDS).max(MAX_DELAY_SECONDS),
  repeatReminderDelaySeconds: z.coerce.number().int().min(MIN_DELAY_SECONDS).max(MAX_DELAY_SECONDS),
  maximumReminders: z.coerce.number().int().min(1).max(10),
});

export type ReminderSettings = z.infer<typeof reminderSettingsSchema> & {
  source: 'saved' | 'server_default';
  updatedAt: string | null;
};

let cached: { value: ReminderSettings; loadedAt: number } | undefined;

export function defaultReminderSettings(): ReminderSettings {
  return {
    dueDays: 3,
    firstReminderDelaySeconds: env.PAYMENT_FIRST_REMINDER_DELAY_SECONDS,
    repeatReminderDelaySeconds: env.PAYMENT_REPEAT_REMINDER_DELAY_SECONDS,
    maximumReminders: env.PAYMENT_TEST_MAX_REMINDERS,
    source: 'server_default',
    updatedAt: null,
  };
}

export async function getReminderSettings(fresh = false): Promise<ReminderSettings> {
  if (!fresh && cached && Date.now() - cached.loadedAt < CACHE_MS) return cached.value;
  const { data, error } = await getSupabaseServerClient()
    .from('system_settings')
    .select('settings')
    .eq('id', 1)
    .maybeSingle();
  if (error) throw new Error(`Unable to load payment reminder settings: ${error.message}`);
  const value = parseStoredReminderSettings(
    isRecord(data?.settings) ? data.settings.payment_reminders : undefined,
  );
  cached = { value, loadedAt: Date.now() };
  return value;
}

export function parseStoredReminderSettings(stored: unknown): ReminderSettings {
  const fallback = defaultReminderSettings();
  if (!isRecord(stored)) return fallback;
  const parsed = reminderSettingsSchema.safeParse({ dueDays: 3, ...stored });
  if (!parsed.success) throw new Error('Saved reminder settings are invalid; new journeys are blocked');
  return {
    ...parsed.data,
    source: 'saved',
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
  };
}

export async function saveReminderSettings(
  input: unknown,
  updatedBy?: { id: string; username: string },
): Promise<ReminderSettings> {
  const next = reminderSettingsSchema.parse(input);
  const client = getSupabaseServerClient();
  const updatedAt = new Date().toISOString();
  // Freeze the old timing before changing defaults. CAS preserves concurrent
  // payment confirmations and never modifies an already-snapshotted journey.
  const beforeSettings = await getReminderSettings(true);
  for (let offset=0; ; offset+=500) {
    if (offset>=10000) throw new Error('Too many legacy journeys to freeze safely; settings were not changed');
    const { data: legacy, error: legacyError } = await client.from('invoice_receivables').select('invoice_id,raw_data')
      .order('invoice_id').range(offset,offset+499);
    if (legacyError) throw new Error('Unable to preserve existing journey settings');
    for (const row of legacy ?? []) {
      const raw = isRecord(row.raw_data) ? row.raw_data : {};
      if (raw.journey_settings) continue;
      const frozen = await client.from('invoice_receivables').update({ raw_data: { ...raw, journey_settings: beforeSettings } })
        .eq('invoice_id', row.invoice_id).eq('raw_data', JSON.stringify(row.raw_data)).select('invoice_id').maybeSingle();
      if (frozen.error || !frozen.data) throw new Error('An existing journey changed while preserving its settings. Retry saving.');
    }
    if ((legacy?.length ?? 0)<500) break;
  }
  const changed = await updateSettingsSection('payment_reminders', () => ({ ...next, updatedAt, updatedBy: updatedBy?.username ?? null }));
  const before = parseStoredReminderSettings(changed.before);
  await client.from('audit_logs').insert({
    actor_type: 'user',
    actor_user_id: auditUserId(updatedBy?.id),
    action: 'payment_reminder_settings_updated',
    entity_type: 'system_settings',
    entity_id: '1',
    before_data: {
      dueDays: before.dueDays,
      firstReminderDelaySeconds: before.firstReminderDelaySeconds,
      repeatReminderDelaySeconds: before.repeatReminderDelaySeconds,
      maximumReminders: before.maximumReminders,
    },
    after_data: next,
    metadata: { username: updatedBy?.username ?? null },
  });
  cached = undefined;
  return { ...next, source: 'saved', updatedAt };
}

export function journeySettings(rawData: unknown, fallback: ReminderSettings): ReminderSettings {
  if (!isRecord(rawData) || !rawData.journey_settings) return fallback;
  const snapshot = reminderSettingsSchema.safeParse(rawData.journey_settings);
  if (!snapshot.success) throw new Error('Invalid frozen journey settings; reminders are blocked');
  return { ...snapshot.data, source: 'saved', updatedAt: null };
}

// Only real user-profile IDs can be stored; the local admin session is not one.
export function auditUserId(userId?: string): string | null {
  return userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
