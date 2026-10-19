import { getSupabaseServerClient } from '../../lib/supabase.js';
import type { CustomerMessagingSetting, InternalRecipient } from './policy.js';

type SettingRow = {
  sap_customer_number: string;
  enabled: boolean;
  approved_phone: string | null;
  enabled_at: string | null;
  manager_name: string | null;
  manager_phone: string | null;
  manager_source: 'manual' | 'sap';
  updated_by: string | null;
  updated_at: string | null;
};

type InternalRow = {
  phone: string;
  label: string | null;
  allow_simulator: boolean;
  allow_payment_reminders: boolean;
  updated_by: string | null;
  updated_at: string | null;
};

const SETTING_COLUMNS =
  'sap_customer_number,enabled,approved_phone,enabled_at,manager_name,manager_phone,manager_source,updated_by,updated_at';
const INTERNAL_COLUMNS = 'phone,label,allow_simulator,allow_payment_reminders,updated_by,updated_at';

function toSetting(row: SettingRow): CustomerMessagingSetting {
  return {
    sapCustomerNumber: row.sap_customer_number,
    enabled: row.enabled,
    approvedPhone: row.approved_phone,
    enabledAt: row.enabled_at,
    managerName: row.manager_name,
    managerPhone: row.manager_phone,
    managerSource: row.manager_source,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

function toInternal(row: InternalRow): InternalRecipient {
  return {
    phone: row.phone,
    label: row.label,
    allowSimulator: row.allow_simulator,
    allowPaymentReminders: row.allow_payment_reminders,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
  };
}

// Send-time reads are deliberately uncached: disabling a customer in Settings
// must take effect on the very next job. Any error propagates so callers fail closed.
export async function getCustomerSetting(
  customerNumber: string,
): Promise<CustomerMessagingSetting | null> {
  const { data, error } = await getSupabaseServerClient()
    .from('customer_messaging_settings')
    .select(SETTING_COLUMNS)
    .eq('sap_customer_number', customerNumber)
    .maybeSingle();
  if (error) throw new Error(`Unable to read customer messaging settings: ${error.message}`);
  return data ? toSetting(data as SettingRow) : null;
}

export async function listCustomerSettings(): Promise<CustomerMessagingSetting[]> {
  const { data, error } = await getSupabaseServerClient()
    .from('customer_messaging_settings')
    .select(SETTING_COLUMNS)
    .order('sap_customer_number');
  if (error) throw new Error(`Unable to list customer messaging settings: ${error.message}`);
  return (data as SettingRow[] | null ?? []).map(toSetting);
}

export async function getInternalRecipient(phone: string): Promise<InternalRecipient | null> {
  const { data, error } = await getSupabaseServerClient()
    .from('internal_test_recipients')
    .select(INTERNAL_COLUMNS)
    .eq('phone', phone)
    .maybeSingle();
  if (error) throw new Error(`Unable to read internal test recipients: ${error.message}`);
  return data ? toInternal(data as InternalRow) : null;
}

export async function listInternalRecipients(): Promise<InternalRecipient[]> {
  const { data, error } = await getSupabaseServerClient()
    .from('internal_test_recipients')
    .select(INTERNAL_COLUMNS)
    .order('phone');
  if (error) throw new Error(`Unable to list internal test recipients: ${error.message}`);
  return (data as InternalRow[] | null ?? []).map(toInternal);
}

export async function saveCustomerSetting(
  customerNumber: string,
  values: Partial<{
    enabled: boolean;
    approved_phone: string | null;
    enabled_at: string | null;
    manager_name: string | null;
    manager_phone: string | null;
    manager_source: 'manual' | 'sap';
  }>,
  updatedBy: string,
): Promise<CustomerMessagingSetting> {
  const { data, error } = await getSupabaseServerClient()
    .from('customer_messaging_settings')
    .upsert(
      { sap_customer_number: customerNumber, ...values, updated_by: updatedBy },
      { onConflict: 'sap_customer_number' },
    )
    .select(SETTING_COLUMNS)
    .single();
  if (error || !data) {
    throw new Error(`Unable to save customer messaging settings: ${error?.message ?? 'no row'}`);
  }
  return toSetting(data as SettingRow);
}

export async function saveInternalRecipient(
  phone: string,
  values: { label: string | null; allow_simulator: boolean; allow_payment_reminders: boolean },
  updatedBy: string,
): Promise<InternalRecipient> {
  const { data, error } = await getSupabaseServerClient()
    .from('internal_test_recipients')
    .upsert({ phone, ...values, updated_by: updatedBy }, { onConflict: 'phone' })
    .select(INTERNAL_COLUMNS)
    .single();
  if (error || !data) {
    throw new Error(`Unable to save internal test recipient: ${error?.message ?? 'no row'}`);
  }
  return toInternal(data as InternalRow);
}

export async function writeMessagingAudit(input: {
  action: string;
  entityId: string;
  before: unknown;
  after: unknown;
  actorUserId?: string;
  username?: string;
}): Promise<void> {
  const { error } = await getSupabaseServerClient().from('audit_logs').insert({
    actor_type: 'user',
    actor_user_id:
      input.actorUserId && /^[0-9a-f-]{36}$/i.test(input.actorUserId) ? input.actorUserId : null,
    action: input.action,
    entity_type: 'messaging_controls',
    entity_id: input.entityId,
    before_data: input.before ?? null,
    after_data: input.after ?? null,
    metadata: { username: input.username ?? null },
  });
  if (error) throw new Error(`Unable to audit the messaging change: ${error.message}`);
}
