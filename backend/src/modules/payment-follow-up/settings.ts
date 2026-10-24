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
    firstReminderDelaySeconds: env.PAYMENT_FIRST_REMINDER_DELAY_SECONDS,
    repeatReminderDelaySeconds: env.PAYMENT_REPEAT_REMINDER_DELAY_SECONDS,
    maximumReminders: env.PAYMENT_TEST_MAX_REMINDERS,
    source: 'server_default',
    updatedAt: null,
  };
}

export async function getReminderSettings(): Promise<ReminderSettings> {
  if (cached && Date.now() - cached.loadedAt < CACHE_MS) return cached.value;
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
  const parsed = reminderSettingsSchema.safeParse(stored);
  if (!parsed.success) return fallback;
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
  const changed = await updateSettingsSection('payment_reminders', () => ({ ...next, updatedAt, updatedBy: updatedBy?.username ?? null }));
  const before = parseStoredReminderSettings(changed.before);
  await client.from('audit_logs').insert({
    actor_type: 'user',
    actor_user_id: auditUserId(updatedBy?.id),
    action: 'payment_reminder_settings_updated',
    entity_type: 'system_settings',
    entity_id: '1',
    before_data: {
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

// Only real user-profile IDs can be stored; the local admin session is not one.
export function auditUserId(userId?: string): string | null {
  return userId && /^[0-9a-f-]{36}$/i.test(userId) ? userId : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
