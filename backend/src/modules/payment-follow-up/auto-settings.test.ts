import assert from 'node:assert/strict';
import { it } from 'node:test';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH:'/dev/null', SUPABASE_URL:'http://127.0.0.1:1',SUPABASE_SERVICE_ROLE_KEY:'fake-only',
});
const { setAutoCustomer, saveAutoMaster, getAutoSettings } = await import('./auto-settings.js');

function mockDb(t: { mock: { method: typeof import('node:test').mock.method } }, options: { customerEnabled: boolean; stored?: unknown }) {
  const saved: unknown[] = [];
  const http = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    if (path.endsWith('/customer_messaging_settings')) {
      return Response.json(options.customerEnabled ? { sap_customer_number: '510191', enabled: true, approved_phone: '918098868251', enabled_at: '2026-10-20T00:00:00Z' } : { sap_customer_number: '510191', enabled: false, approved_phone: null, enabled_at: null });
    }
    if (path.endsWith('/system_settings')) {
      if (method === 'PATCH') { saved.push(JSON.parse(String(init?.body)).settings); return Response.json({ id: 1 }); }
      return Response.json({ settings: { ...(options.stored ? { auto_payment_reminders: options.stored } : {}) }, updated_at: '2026-11-17T00:00:00Z' });
    }
    if (path.endsWith('/audit_logs')) return Response.json([]);
    throw new Error('Unexpected request: ' + path);
  });
  return { http, saved };
}

it('only an enabled customer can be made automatic', async (t) => {
  const db = mockDb(t, { customerEnabled: false });
  try {
    await assert.rejects(setAutoCustomer('510191', true), /Turn messaging on/);
    assert.deepEqual(db.saved, [], 'nothing was written');
  } finally { db.http.mock.restore(); }
});

it('turning a customer on records them, and off removes only them', async (t) => {
  const on = mockDb(t, { customerEnabled: true });
  try {
    const result = await setAutoCustomer('510191', true, { id: 'x', username: 'admin' });
    assert.deepEqual(Object.keys(result.customers), ['510191']);
    assert.equal(result.enabled, false, 'making a customer automatic does not switch the master on');
  } finally { on.http.mock.restore(); }
  const off = mockDb(t, { customerEnabled: true, stored: { enabled: true, customers: { '510191': { enabledAt: 'x' }, '530234': { enabledAt: 'y' } } } });
  try {
    const result = await setAutoCustomer('510191', false);
    assert.deepEqual(Object.keys(result.customers), ['530234']);
    assert.equal(result.enabled, true, 'the master switch is left as it was');
  } finally { off.http.mock.restore(); }
});

it('the master switch and go-live date are saved, and customers are kept', async (t) => {
  const db = mockDb(t, { customerEnabled: true, stored: { enabled: false, customers: { '510191': { enabledAt: 'x' } } } });
  try {
    const result = await saveAutoMaster({ enabled: true, goLiveDate: '2026-11-18' });
    assert.equal(result.enabled, true);
    assert.equal(result.goLiveDate, '2026-11-18');
    assert.deepEqual(Object.keys(result.customers), ['510191']);
  } finally { db.http.mock.restore(); }
});

it('reads as off when nothing is stored', async (t) => {
  const db = mockDb(t, { customerEnabled: true });
  try { assert.equal((await getAutoSettings()).enabled, false); } finally { db.http.mock.restore(); }
});
