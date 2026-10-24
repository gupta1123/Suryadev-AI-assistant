import { getSupabaseServerClient } from './supabase.js';

// All settings-section writers use compare-and-swap so concurrent saves cannot
// overwrite another section (or silently undo a material being turned Off).
export async function updateSettingsSection(
  key: string,
  build: (previous: unknown) => unknown,
): Promise<{ before: unknown; after: unknown; updatedAt: string }> {
  const client = getSupabaseServerClient();
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: row, error } = await client.from('system_settings').select('settings').eq('id', 1).single();
    if (error || !row || !row.settings || typeof row.settings !== 'object' || Array.isArray(row.settings)) {
      throw new Error('Unable to read system settings safely');
    }
    const before = row.settings[key];
    const after = build(before);
    const updatedAt = new Date().toISOString();
    const saved = await client.from('system_settings').update({
      settings: { ...row.settings, [key]: after }, updated_at: updatedAt,
    }).eq('id', 1).eq('settings', JSON.stringify(row.settings)).select('id').maybeSingle();
    if (saved.error) throw new Error(`Unable to save system settings: ${saved.error.message}`);
    if (saved.data) return { before, after, updatedAt };
  }
  throw new Error('Settings changed while saving. Refresh and try again.');
}
