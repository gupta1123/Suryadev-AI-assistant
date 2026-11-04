import { getSupabaseServerClient } from './supabase.js';

// All settings-section writers use compare-and-swap so concurrent saves cannot
// overwrite another section (or silently undo a material being turned Off).
export async function updateSettingsSection(
  key: string,
  build: (previous: unknown) => unknown,
): Promise<{ before: unknown; after: unknown; updatedAt: string }> {
  const client = getSupabaseServerClient();
  for (let attempt = 0; attempt < 4; attempt++) {
    const { data: row, error } = await client.from('system_settings').select('settings,updated_at').eq('id', 1).single();
    if (error || !row || !row.updated_at || !row.settings || typeof row.settings !== 'object' || Array.isArray(row.settings)) {
      throw new Error('Unable to read system settings safely');
    }
    const before = row.settings[key];
    const after = build(before);
    // The database trigger advances updated_at on each write. Keep the full
    // timestamp precision for the comparison and the settings JSON in the body.
    const updatedAt = new Date().toISOString();
    const saved = await client.from('system_settings').update({
      settings: { ...row.settings, [key]: after },
    }).eq('id', 1).eq('updated_at', row.updated_at).select('id').maybeSingle();
    if (saved.error) throw new Error(`Unable to save system settings: ${saved.error.message}`);
    if (saved.data) return { before, after, updatedAt };
  }
  throw new Error('Settings changed while saving. Refresh and try again.');
}
