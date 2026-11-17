import assert from 'node:assert/strict';
import { it } from 'node:test';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH:'/dev/null', SUPABASE_URL:'http://127.0.0.1:1',SUPABASE_SERVICE_ROLE_KEY:'fake-only',
  SAP_API_BASE_URL:'http://127.0.0.1:2/sap/opu/odata/sap',SAP_API_USERNAME:'fake',SAP_API_PASSWORD:'fake',SAP_EXPECTED_HOST:'127.0.0.1',
});
const { decideAutoStart, syncJourneysWithSap, runAutoStart } = await import('./automation.js');
const { parseAutoSettings, autoMasterSchema } = await import('./auto-settings.js');

const on = { goLiveDate: null, customers: { '510191': { enabledAt: 't', enabledBy: 'a' } } };
const row = (change: Record<string, unknown> = {}) => ({ customerNumber: '510191', payment: 'not_paid' as const, dueDate: '2026-11-11', ...change });

it('starts only a not-paid invoice of an automatic customer', () => {
  assert.equal(decideAutoStart(row(), on).start, true);
  assert.equal(decideAutoStart(row({ customerNumber: '999' }), on).start, false, 'a customer that is not automatic is left alone');
  for (const payment of ['partly_paid', 'paid', 'cancelled', 'unknown', 'unavailable'] as const) {
    const decision = decideAutoStart(row({ payment }), on);
    assert.equal(decision.start, false, payment);
    assert.ok(decision.reason, `${payment} gives a reason`);
  }
});

it('the go-live date keeps older invoices out, and an empty date puts no limit', () => {
  const settings = { ...on, goLiveDate: '2026-11-18' };
  assert.equal(decideAutoStart(row({ dueDate: '2026-11-17' }), settings).start, false, 'reached its start day before go-live');
  assert.equal(decideAutoStart(row({ dueDate: '2026-11-18' }), settings).start, true, 'reaches it on the go-live day');
  assert.equal(decideAutoStart(row({ dueDate: '2026-11-25' }), settings).start, true);
  assert.equal(decideAutoStart(row({ dueDate: '2020-01-01' }), on).start, true, 'no date, no limit');
});

it('automatic settings start OFF and ignore anything malformed', () => {
  for (const stored of [undefined, null, 'on', 7, [], {}, { enabled: 'true' }, { enabled: 1 }]) assert.equal(parseAutoSettings(stored).enabled, false);
  assert.equal(parseAutoSettings({ enabled: true, goLiveDate: 'soon' }).goLiveDate, null);
  assert.equal(parseAutoSettings({ enabled: true, goLiveDate: '2026-02-30' }).goLiveDate, null, 'not a real date');
  assert.deepEqual(Object.keys(parseAutoSettings({ customers: { '510191': { enabledAt: 'x' }, '../x': { enabledAt: 'y' }, '5': 'bad' } }).customers), ['510191']);
  assert.equal(autoMasterSchema.safeParse({ enabled: true, goLiveDate: '' }).success, true);
  assert.equal(autoMasterSchema.safeParse({ enabled: true, goLiveDate: '2026-13-01' }).success, false);
  assert.equal(autoMasterSchema.safeParse({ enabled: true, goLiveDate: null, extra: 1 }).success, false);
});

type Setup = { clearing: string; baseline?: string; hold?: boolean; manual?: boolean };
async function runSync(t: { mock: { method: typeof import('node:test').mock.method } }, setup: Setup) {
  const writes: Array<{ method: string; path: string; body: string }> = [];
  const raw = { ...(setup.manual === false ? {} : { manual_payment_journey: true }), ...(setup.baseline !== undefined ? { sap_clearing_baseline: setup.baseline } : {}), ...(setup.hold ? { journey_hold: { reason: 'stopped_by_user' } } : {}) };
  const http = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const path = new URL(String(input)).pathname;
    const method = init?.method ?? 'GET';
    const single = String(new Headers(init?.headers).get('accept')).includes('pgrst.object');
    if (method !== 'GET') writes.push({ method, path, body: String(init?.body ?? '') });
    if (path.endsWith('/A_BillingDocument')) return Response.json({ d: { results: [{ BillingDocument: '26ST000042', InvoiceClearingStatus: setup.clearing }] } });
    if (method !== 'GET') return single ? Response.json({ id: 7 }) : Response.json([{ id: 7 }]);
    if (path.endsWith('/payment_follow_up_cases')) return single ? Response.json({ id: 7, invoice_id: 2, status: 'active' }) : Response.json([{ id: 7, invoice_id: 2, status: 'active' }]);
    if (path.endsWith('/invoice_receivables')) return single ? Response.json({ original_amount: 1000, outstanding_amount: 1000, currency: 'INR', due_date: '2026-11-11', raw_data: raw }) : Response.json([{ invoice_id: 2, raw_data: raw }]);
    if (path.endsWith('/invoices')) return Response.json([{ id: 2, sap_billing_document: '26ST000042' }]);
    return single ? Response.json({}) : Response.json([]);
  });
  try { return { result: await syncJourneysWithSap(), writes }; } finally { http.mock.restore(); }
}

it('closes a running journey as paid when SAP shows the invoice fully paid', async (t) => {
  const { result, writes } = await runSync(t, { clearing: 'C', baseline: 'A' });
  assert.deepEqual(result.cleared, [7]);
  const paid = writes.find((write) => write.path.endsWith('/invoice_receivables'));
  assert.ok(paid && paid.body.includes('sap_cleared') && paid.body.includes('"payment_status":"paid"'), 'the invoice is recorded as paid, with SAP as the source');
  assert.ok(writes.some((write) => write.path.endsWith('/payment_follow_up_cases') && write.body.includes('resolved')), 'the journey is resolved');
});

it('pauses a journey when SAP shows partly paid after it began, but leaves one that began partly paid', async (t) => {
  const after = await runSync(t, { clearing: 'B', baseline: 'A' });
  assert.deepEqual(after.result.held, [7]);
  assert.ok(after.writes.some((write) => write.path.endsWith('/invoice_receivables') && write.body.includes('partly_paid_in_sap')), 'the hold is written on the invoice');
  assert.ok(after.writes.some((write) => write.path.endsWith('/payment_follow_up_cases') && write.body.includes('"status":"paused"')));
  assert.ok(!after.writes.some((write) => write.body.includes('"payment_status":"paid"')), 'partly paid is never recorded as paid');
  const before = await runSync(t, { clearing: 'B', baseline: 'B' });
  assert.deepEqual(before.result, { cleared: [], held: [] });
  assert.deepEqual(before.writes, [], 'a person confirmed the amount when starting, so nothing changes');
});

it('does nothing for an unpaid invoice, a stopped journey, or a journey not started from this page', async (t) => {
  const unpaid = await runSync(t, { clearing: 'A', baseline: 'A' });
  assert.deepEqual(unpaid.writes, []);
  const stopped = await runSync(t, { clearing: 'C', baseline: 'A', hold: true });
  assert.deepEqual(stopped.writes, [], 'a stopped journey is not touched, even if SAP now shows paid');
  const legacy = await runSync(t, { clearing: 'C', manual: false });
  assert.deepEqual(legacy.writes, [], 'old demo journeys are never changed');
});

it('remembers what SAP showed for a journey that began before this check existed', async (t) => {
  const { writes } = await runSync(t, { clearing: 'A' });
  assert.ok(writes.some((write) => write.path.endsWith('/invoice_receivables') && write.body.includes('"sap_clearing_baseline":"A"')));
});

it('the automatic start does nothing, and asks SAP nothing, while the master switch is off', async (t) => {
  const seen: string[] = [];
  const http = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    seen.push(path);
    if (path.includes('system_settings')) return Response.json({ settings: { auto_payment_reminders: { enabled: false, customers: { '510191': { enabledAt: 'x' } } } } });
    throw new Error('Nothing else may be read while the switch is off: ' + path);
  });
  try {
    assert.deepEqual(await runAutoStart(), { started: [], skipped: 0 });
    assert.deepEqual(seen.filter((path) => !path.includes('system_settings')), []);
  } finally { http.mock.restore(); }
});

it('the automatic start is off when the settings cannot be read', async (t) => {
  const http = t.mock.method(globalThis, 'fetch', async () => Response.json({ message: 'down' }, { status: 500 }));
  try { await assert.rejects(runAutoStart()); } finally { http.mock.restore(); }
});
