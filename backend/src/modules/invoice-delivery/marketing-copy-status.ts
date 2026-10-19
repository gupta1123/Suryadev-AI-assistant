import { env } from '../../config/env.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import { formatPhone } from './policy.js';

// Never expose the snapshot payload (customer data, sender internals or URLs).
export async function getMarketingCopyStatuses(jobIds: number[]) {
  const result = new Map<number, {
    enabled: boolean;
    recipient: string;
    copies: Record<string, unknown>[];
  }>();
  for (const id of jobIds) result.set(id, {
    enabled: env.MSG91_MARKETING_COPY_ENABLED,
    recipient: 'Assigned per client', copies: [],
  });
  if (!jobIds.length) return result;
  const { data, error } = await getSupabaseServerClient().from('marketing_whatsapp_copies')
    .select('id,source_job_id,recipient,status,attempt_count,accepted_at,last_error,created_at')
    .in('source_job_id', jobIds).order('id', { ascending: true });
  if (error) throw new Error(`Unable to load marketing manager copy status: ${error.message}`);
  for (const row of data ?? []) result.get(Number(row.source_job_id))?.copies.push({
    id: Number(row.id), recipient: formatPhone(String(row.recipient)),
    status: row.status, attempt_count: row.attempt_count,
    accepted_at: row.accepted_at, last_error: row.last_error, created_at: row.created_at,
  });
  return result;
}
