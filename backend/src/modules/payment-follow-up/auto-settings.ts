import { z } from 'zod';
import { env } from '../../config/env.js';
import { HttpError } from '../../lib/http.js';
import { updateSettingsSection } from '../../lib/settings-store.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import { getCustomerSetting } from '../messaging/repository.js';
import { auditUserId } from './settings.js';

// Automatic payment reminders. Everything starts OFF: nothing starts by itself until an admin turns the
// master switch on AND marks a customer as automatic. Stored in system_settings.auto_payment_reminders.
const KEY = 'auto_payment_reminders';

const calendarDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00.000Z`);
  return !Number.isNaN(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
}, 'Use a real calendar date');

export const autoMasterSchema = z.object({
  enabled: z.boolean(),
  // Only invoices that reach their due date on or after this day start by themselves. Empty means no limit.
  goLiveDate: z.preprocess((value) => (value === '' ? null : value), calendarDate.nullable()),
}).strict();

export type AutoSettings = {
  enabled: boolean;
  goLiveDate: string | null;
  customers: Record<string, { enabledAt: string; enabledBy: string | null }>;
  updatedAt: string | null;
};

const record = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function parseAutoSettings(stored: unknown): AutoSettings {
  const off: AutoSettings = { enabled: false, goLiveDate: null, customers: {}, updatedAt: null };
  if (!record(stored)) return off;
  const customers: AutoSettings['customers'] = {};
  if (record(stored.customers)) {
    for (const [number, entry] of Object.entries(stored.customers)) {
      if (!/^[A-Za-z0-9]{1,20}$/.test(number) || !record(entry)) continue;
      customers[number] = { enabledAt: String(entry.enabledAt ?? ''), enabledBy: typeof entry.enabledBy === 'string' ? entry.enabledBy : null };
    }
  }
  const goLive = calendarDate.safeParse(stored.goLiveDate);
  return {
    enabled: stored.enabled === true,
    goLiveDate: goLive.success ? goLive.data : null,
    customers,
    updatedAt: typeof stored.updatedAt === 'string' ? stored.updatedAt : null,
  };
}

export async function getAutoSettings(): Promise<AutoSettings> {
  const { data, error } = await getSupabaseServerClient().from('system_settings').select('settings').eq('id', 1).maybeSingle();
  // A read failure must never read as "on": the safe answer is that nothing starts automatically.
  if (error) throw new Error('Unable to read automatic reminder settings');
  return parseAutoSettings(record(data?.settings) ? data.settings[KEY] : undefined);
}

/** True when the server itself is set up to send payment reminders (the same gate the Start journey button uses). */
export function serverCanSendReminders(): boolean {
  return env.PAYMENT_JOURNEY_MODE === 'manual' && env.PAYMENT_FOLLOW_UP_ENABLED && env.PAYMENT_FOLLOW_UP_SEND_ENABLED && env.MSG91_SEND_ENABLED;
}

async function audit(action: string, entityId: string, before: unknown, after: unknown, actor?: { id: string; username: string }) {
  await getSupabaseServerClient().from('audit_logs').insert({
    actor_type: 'user', actor_user_id: auditUserId(actor?.id), action, entity_type: 'system_settings', entity_id: entityId,
    before_data: before as never, after_data: after as never, metadata: { username: actor?.username ?? null },
  });
}

export async function saveAutoMaster(input: z.infer<typeof autoMasterSchema>, actor?: { id: string; username: string }): Promise<AutoSettings> {
  const changed = await updateSettingsSection(KEY, (previous) => {
    const current = parseAutoSettings(previous);
    return { ...current, enabled: input.enabled, goLiveDate: input.goLiveDate, updatedAt: new Date().toISOString(), updatedBy: actor?.username ?? null };
  });
  await audit('auto_payment_reminders_master_changed', '1', parseAutoSettings(changed.before), parseAutoSettings(changed.after), actor);
  return parseAutoSettings(changed.after);
}

export async function setAutoCustomer(customerNumber: string, on: boolean, actor?: { id: string; username: string }): Promise<AutoSettings> {
  if (!/^[A-Za-z0-9]{1,20}$/.test(customerNumber)) throw new HttpError(400, 'Invalid customer number');
  if (on) {
    const setting = await getCustomerSetting(customerNumber);
    if (!setting?.enabled || !setting.approvedPhone || !setting.enabledAt) {
      throw new HttpError(409, 'Turn messaging on for this customer first. Only an enabled customer can be made automatic.');
    }
  }
  const changed = await updateSettingsSection(KEY, (previous) => {
    const current = parseAutoSettings(previous);
    const customers = { ...current.customers };
    if (on) customers[customerNumber] = { enabledAt: new Date().toISOString(), enabledBy: actor?.username ?? null };
    else delete customers[customerNumber];
    return { ...current, customers, updatedAt: new Date().toISOString() };
  });
  await audit(on ? 'auto_payment_reminders_customer_on' : 'auto_payment_reminders_customer_off', customerNumber,
    { automatic: Boolean(parseAutoSettings(changed.before).customers[customerNumber]) }, { automatic: on }, actor);
  return parseAutoSettings(changed.after);
}
