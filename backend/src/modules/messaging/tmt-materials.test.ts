import assert from 'node:assert/strict';
import { before, after, describe, it, mock } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: '/dev/null', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'fake-key',
  SAP_API_BASE_URL: 'https://sap.test/sap/opu/odata/sap', SAP_API_USERNAME: 'fake', SAP_API_PASSWORD: 'fake', SAP_EXPECTED_HOST: 'sap.test',
  TMT_MATERIAL_CONTROL_MODE: 'dashboard', SAP_TMT_MATERIAL_IDS: '30000123,30000038,30000130,30000124',
  DELIVERY_MODE: 'test', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin',
});
const { app } = await import('../../app.js');
const { assertInvoiceTmtAllowed, materialItemsBlocker, parseMaterialState } = await import('./tmt-materials.js');
const { sendTemplatePayload } = await import('../invoice-delivery/msg91-client.js');
const { updateSettingsSection } = await import('../../lib/settings-store.js');
const originalFetch = globalThis.fetch;
let state: Record<string, any> = { help_request_alerts: { recipient: '919445029682' }, payment_reminders: { maximumReminders: 3 } };
let sapDown = false;
let productMasterDown = false;
let databaseDown = false;
let conflictOnce = false;
let writes = 0;
let providerCalls = 0;
let server: Server;
let base = '';
let cookie = '';
let mocked: ReturnType<typeof mock.method>;
before(async () => {
  mocked = mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'sap.test') {
      if (sapDown) return Response.json({ error: 'unavailable' }, { status: 503 });
      const filter = url.searchParams.get('$filter');
      if (url.pathname.endsWith('/A_BillingDocumentItem')) return Response.json({ d: { results: [{ Material: '30000032', MaterialGroup: '190', BillingDocumentItemText: 'Billed bend 10mm' }] } });
      if (productMasterDown) return Response.json({ error: { message: { value: 'no start authorization' } } }, { status: 403 });
      const desc = (text: string) => ({ results: [{ Language: 'DE', ProductDescription: 'x' }, { Language: 'EN', ProductDescription: text }] });
      const rows = [{ Product: '30000032', ProductType: 'ZFG', ProductGroup: '190', BaseUnit: 'MT', IsMarkedForDeletion: false, to_Description: desc('Suryadev Fe550D Bend 10mm') },
        { Product: '30000123', ProductType: 'ZFG', ProductGroup: '190', BaseUnit: 'MT', IsMarkedForDeletion: false, to_Description: desc('Existing TMT material') },
        { Product: '10000000', ProductType: 'ZRM', ProductGroup: '168', BaseUnit: 'MT', IsMarkedForDeletion: false, to_Description: desc('Pig Iron') },
        { Product: '30000999', ProductType: 'ZFG', ProductGroup: '190', BaseUnit: 'MT', IsMarkedForDeletion: true, to_Description: desc('Deleted product') }];
      assert.match(url.pathname, /API_PRODUCT_SRV\/A_Product$/, 'list must come from the Product Master, not billing items');
      assert.equal(url.searchParams.get('$expand'), 'to_Description');
      if (filter) { const exact = /^Product eq '(.+)'$/.exec(filter); if (exact) return Response.json({ d: { results: rows.filter(x => x.Product === exact[1]) } }); assert.match(filter, /ProductType eq 'ZFG'.*IsMarkedForDeletion eq false/); }
      return Response.json({ d: { results: rows } });
    }
    if (url.origin === 'http://127.0.0.1:1') {
      if (databaseDown) return Response.json({ message: 'unavailable' }, { status: 503 });
      if (url.pathname.endsWith('/system_settings')) {
        if (init?.method === 'PATCH') {
          if (conflictOnce) { conflictOnce = false; state.other_section = { retained: true }; return Response.json(null); }
          assert.equal(url.searchParams.get('settings'), 'eq.' + JSON.stringify(state), 'saves must use compare-and-swap');
          state = JSON.parse(String(init.body)).settings; writes++;
          return Response.json({ id: 1 });
        }
        return Response.json({ settings: structuredClone(state) });
      }
      if (url.pathname.endsWith('/invoice_items')) return Response.json([{ product_id: '30000032' }]);
      if (url.pathname.endsWith('/audit_logs')) return Response.json([]);
    }
    if (url.hostname === 'control.msg91.com') providerCalls++;
    throw new Error(`Unexpected request in isolated test: ${url.origin}${url.pathname}`);
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const login = await originalFetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) });
  assert.equal(login.status, 200); cookie = login.headers.get('set-cookie')!.split(';')[0]!;
});
after(async () => { mocked.mock.restore(); await new Promise<void>(resolve => server.close(() => resolve())); assert.equal(providerCalls, 0); });
const get = () => originalFetch(base + '/messaging/tmt-materials', { headers: { cookie } });
const put = (enabled: boolean, expectedEnabled: boolean, extra = {}, code = '30000032') => originalFetch(base + '/messaging/tmt-materials/' + code, {
  method: 'PUT', headers: { cookie, 'content-type': 'application/json' },
  body: JSON.stringify({ enabled, expectedEnabled, confirmMaterial: code, acknowledgePending: true, ...extra }),
});

describe('TMT material controls: isolated services, never sends', () => {
  it('keeps the four existing exact approvals On and new SAP materials Off without writes', async () => {
    const r = await get(); assert.equal(r.status, 200);
    const { data } = await r.json() as any;
    assert.equal(data.items.filter((x: any) => x.enabled).length, 4);
    assert.equal(data.items.find((x: any) => x.code === '30000032').enabled, false);
    const pig = data.items.find((x: any) => x.code === '10000000');
    assert.deepEqual([pig.description, pig.type, pig.group, pig.unit, pig.enabled], ['Pig Iron', 'ZRM', '168', 'MT', false]);
    assert.equal(data.items.some((x: any) => x.code === '30000999'), false, 'products marked for deletion are not listed');
    assert.equal(writes, 0);
  });
  it('falls back to materials on billing documents when the Product Master is not readable', async () => {
    productMasterDown = true;
    try {
      const r = await originalFetch(base + '/messaging/tmt-materials?refresh=true', { headers: { cookie } });
      const { data } = await r.json() as any;
      assert.equal(data.source, 'billing_documents'); assert.equal(data.directoryError, null);
      assert.match(data.note, /not reachable/);
      assert.equal(data.items.find((x: any) => x.code === '30000032').description, 'Billed bend 10mm');
    } finally { productMasterDown = false; }
    const back = await (await originalFetch(base + '/messaging/tmt-materials?refresh=true', { headers: { cookie } })).json() as any;
    assert.equal(back.data.source, 'product_master');
  });
  it('requires admin authentication for reads and writes', async () => {
    assert.equal((await originalFetch(base + '/messaging/tmt-materials')).status, 401);
    assert.equal((await originalFetch(base + '/messaging/tmt-materials/30000032', { method: 'PUT' })).status, 401);
  });
  it('rejects unconfirmed changes, wrong codes and materials absent from SAP', async () => {
    assert.equal((await put(true, false, { acknowledgePending: false })).status, 409);
    assert.equal((await put(true, false, { confirmMaterial: '30000038' })).status, 409);
    assert.equal((await put(true, false, {}, '99999999')).status, 404);
    assert.equal(writes, 0);
  });
  it('blocks a new material at the final provider boundary', async () => {
    await assert.rejects(sendTemplatePayload({}, 1000, () => assertInvoiceTmtAllowed(1)), /30000032/);
    assert.equal(providerCalls, 0);
  });
  it('enables only the exact material and preserves unrelated settings', async () => {
    assert.equal((await put(true, false)).status, 200);
    assert.equal(state.tmt_material_controls.materials['30000032'].enabled, true);
    assert.equal(state.help_request_alerts.recipient, '919445029682');
    assert.equal(state.payment_reminders.maximumReminders, 3);
    await assertInvoiceTmtAllowed(1);
    assert.equal(providerCalls, 0);
  });
  it('rejects stale status rather than overwriting another admin change', async () => {
    assert.equal((await put(true, false)).status, 409);
  });
  it('allows Off during a SAP outage and rechecks it at final dispatch', async () => {
    await assertInvoiceTmtAllowed(1);
    sapDown = true;
    try { assert.equal((await put(false, true)).status, 200); } finally { sapDown = false; }
    await assert.rejects(sendTemplatePayload({}, 1000, () => assertInvoiceTmtAllowed(1)), /Off or not approved/);
    assert.equal(providerCalls, 0);
  });
  it('explicit Off beats an environment default, a TMT description, and other On lines', () => {
    const saved = parseMaterialState({ version: 1, materials: { '30000123': { enabled: false, description: 'TMT', updatedAt: '2026-10-24T00:00:00Z', updatedBy: 'admin' } } });
    assert.match(materialItemsBlocker([{ itemNumber: '1', productId: '30000123', description: 'TMT', rawData: {} }, { itemNumber: '2', productId: '30000038', rawData: {} }], saved)!, /30000123/);
    assert.match(materialItemsBlocker([], saved)!, /no material lines/);
    assert.match(materialItemsBlocker([{ itemNumber: '1', rawData: {} }], saved)!, /missing code/);
    assert.throws(() => parseMaterialState({ materials: {} }), /invalid/);
  });
  it('fails closed when the saved material controls cannot be read', async () => {
    databaseDown = true;
    try { await assert.rejects(assertInvoiceTmtAllowed(1), /Unable to verify/); } finally { databaseDown = false; }
  });
  it('retries a concurrent settings save while preserving the other section', async () => {
    conflictOnce = true;
    await updateSettingsSection('unrelated_test', () => ({ saved: true }));
    assert.equal(state.other_section.retained, true);
    assert.equal(state.unrelated_test.saved, true);
    assert.equal(state.tmt_material_controls.materials['30000032'].enabled, false);
  });
});
