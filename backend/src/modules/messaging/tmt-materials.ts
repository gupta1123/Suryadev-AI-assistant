import { z } from 'zod';
import { env, sapProductConnection, sapTmtMaterialIds } from '../../config/env.js';
import { getSupabaseServerClient } from '../../lib/supabase.js';
import { HttpError } from '../../lib/http.js';
import { updateSettingsSection } from '../../lib/settings-store.js';
import { SapODataClient, escapeODataString, type ODataRecord } from '../invoice-delivery/sap-client.js';
import { isTmtDocument } from '../invoice-delivery/document-policy.js';
import type { SapInvoiceItem } from '../invoice-delivery/domain.js';

export const materialCodeSchema = z.string().trim().regex(/^[A-Za-z0-9][A-Za-z0-9_.-]{0,39}$/).transform(x => x.toUpperCase());
const entrySchema = z.object({ enabled: z.boolean(), description: z.string(), updatedAt: z.string().datetime(), updatedBy: z.string() });
const stateSchema = z.object({ version: z.literal(1), materials: z.record(z.string(), entrySchema) });
type State = z.infer<typeof stateSchema>;
export class TmtMaterialRefusal extends Error {}
export type Material = { code: string; description: string; group: string; type: string; unit: string; enabled: boolean; source: 'saved' | 'server_default' | 'not_enabled'; updatedAt: string | null };
const KEY = 'tmt_material_controls';
const normalize = (value: unknown) => String(value ?? '').trim().toUpperCase();

export function parseMaterialState(raw: unknown): State {
  if (raw === undefined) return { version: 1, materials: {} };
  const parsed = stateSchema.safeParse(raw);
  if (!parsed.success) throw new Error('TMT material settings are invalid; sending is blocked');
  return parsed.data;
}
export async function readMaterialState(): Promise<State> {
  const { data, error } = await getSupabaseServerClient().from('system_settings').select('settings').eq('id', 1).single();
  if (error || !data?.settings || typeof data.settings !== 'object' || Array.isArray(data.settings)) throw new Error('TMT material settings are unavailable; sending is blocked');
  return parseMaterialState(data.settings[KEY]);
}
export function materialEnabled(state: State, code: string): boolean {
  const id = normalize(code);
  return state.materials[id]?.enabled ?? sapTmtMaterialIds.has(id);
}
export function materialItemsBlocker(items: SapInvoiceItem[], state: State): string | null {
  // The attachment contains the whole invoice, not selected lines. An explicitly
  // Off or unknown line cannot be leaked through another line that is On.
  if (!items.length) return 'document has no material lines; sending is blocked';
  const blocked = [...new Set(items.filter(x => !materialEnabled(state, x.productId ?? '')).map(x => normalize(x.productId) || '(missing code)'))];
  return blocked.length ? `TMT material(s) Off or not approved: ${blocked.join(', ')}; the whole document is blocked` : null;
}
export async function tmtMaterialBlocker(items: SapInvoiceItem[]): Promise<string | null> {
  if (env.TMT_MATERIAL_CONTROL_MODE !== 'dashboard') return isTmtDocument({ items }) ? null : 'billing document does not contain a configured TMT material';
  return materialItemsBlocker(items, await readMaterialState());
}
export async function assertInvoiceTmtAllowed(invoiceId: number): Promise<void> {
  if (env.TMT_MATERIAL_CONTROL_MODE !== 'dashboard') return;
  const { data, error } = await getSupabaseServerClient().from('invoice_items')
    .select('product_id').eq('invoice_id', invoiceId).limit(1000);
  if (error || !data || data.length >= 1000) throw new Error('Unable to verify all document materials; sending is blocked');
  const reason = materialItemsBlocker(data.map(row => ({ itemNumber: '', productId: row.product_id, rawData: {} })), await readMaterialState());
  if (reason) throw new TmtMaterialRefusal(reason);
}

type Discovered = { code: string; description: string; group: string; type: string; unit: string };
let cache: { items: Discovered[]; checkedAt: string; loadedAt: number } | undefined;
const PRODUCT_TYPES = env.SAP_PRODUCT_TYPES.split(',').map(x => x.trim().toUpperCase()).filter(Boolean);
export function productRows(rows: ODataRecord[]): Discovered[] {
  const unique = new Map<string, Discovered>();
  for (const row of rows) {
    const code = normalize(row.Product);
    if (!materialCodeSchema.safeParse(code).success || row.IsMarkedForDeletion === true || unique.has(code)) continue;
    const texts = (row.to_Description as { results?: ODataRecord[] } | undefined)?.results ?? [];
    const text = texts.find(x => x.Language === 'EN') ?? texts[0];
    unique.set(code, { code, description: String(text?.ProductDescription ?? '').trim(), group: String(row.ProductGroup ?? '').trim(),
      type: normalize(row.ProductType), unit: String(row.BaseUnit ?? '').trim() });
  }
  return [...unique.values()];
}
// Reads the SAP Product Master (the real item list), not the items that happen to be on invoices.
async function sapProducts(code?: string): Promise<Discovered[]> {
  if (!sapProductConnection) throw new HttpError(409, 'SAP API connection is unavailable');
  const client = new SapODataClient(sapProductConnection.baseUrl, sapProductConnection.username, sapProductConnection.password);
  const types = PRODUCT_TYPES.map(x => `ProductType eq '${escapeODataString(x)}'`).join(' or ');
  const filter = code ? `Product eq '${escapeODataString(code)}'` : `(${types}) and IsMarkedForDeletion eq false`;
  return productRows(await client.collection('API_PRODUCT_SRV', 'A_Product', {
    filter, select: ['Product', 'ProductType', 'ProductGroup', 'BaseUnit', 'IsMarkedForDeletion', 'to_Description'], expand: 'to_Description', top: code ? 1 : 2000,
  }));
}
export async function listTmtMaterials(refresh = false, exactCode?: string) {
  let directoryError: string | null = null;
  if (!cache || refresh || Date.now() - cache.loadedAt > 5 * 60_000) {
    try {
      cache = { items: await sapProducts(), checkedAt: new Date().toISOString(), loadedAt: Date.now() };
    } catch { directoryError = 'The SAP product list could not be read, so no product list is shown. Only materials already approved in this app appear below. Use Refresh to retry.'; }
  }
  const state = await readMaterialState();
  const byCode = new Map((cache?.items ?? []).map(row => [row.code, row]));
  if (exactCode) {
    const found = (await sapProducts(exactCode))[0];
    if (!found) throw new HttpError(404, 'This material was not found in the SAP product list');
    byCode.set(found.code, found);
  }
  for (const code of new Set([...sapTmtMaterialIds, ...Object.keys(state.materials)])) {
    if (!byCode.has(code)) byCode.set(code, { code, description: state.materials[code]?.description ?? '', group: '', type: '', unit: '' });
  }
  const items = [...byCode.values()].map<Material>(row => ({ ...row, enabled: materialEnabled(state, row.code),
    source: state.materials[row.code] ? 'saved' : sapTmtMaterialIds.has(row.code) ? 'server_default' : 'not_enabled',
    updatedAt: state.materials[row.code]?.updatedAt ?? null,
  })).sort((a,b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
  return { items, directoryError, checkedAt: cache?.checkedAt ?? null, mode: env.TMT_MATERIAL_CONTROL_MODE, productTypes: PRODUCT_TYPES,
    note: 'Products from the SAP Product Master. New codes start Off. All material lines must be On because the whole PDF is sent.' };
}
export async function setTmtMaterial(code: string, enabled: boolean, expectedEnabled: boolean, username: string) {
  if (env.TMT_MATERIAL_CONTROL_MODE !== 'dashboard') throw new HttpError(409, 'Dashboard material controls are not active on this server');
  const found = enabled ? (await sapProducts(code))[0] : undefined;
  if (enabled && !found) throw new HttpError(404, 'Material was not found in the SAP product list; approval is blocked');
  return updateSettingsSection(KEY, previous => {
    const state = parseMaterialState(previous);
    if (materialEnabled(state, code) !== expectedEnabled) throw new HttpError(409, 'Material status changed. Refresh before saving.');
    return { ...state, materials: { ...state.materials, [code]: {
      enabled, description: found?.description ?? state.materials[code]?.description ?? '',
      updatedAt: new Date().toISOString(), updatedBy: username,
    } } };
  });
}
