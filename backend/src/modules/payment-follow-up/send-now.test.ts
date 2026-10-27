import assert from 'node:assert/strict';
import { it } from 'node:test';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: '/dev/null', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'fake-only',
  DELIVERY_MODE: 'test', PAYMENT_FOLLOW_UP_ENABLED: 'true', PAYMENT_FOLLOW_UP_SEND_ENABLED: 'true', MSG91_SEND_ENABLED: 'true',
  PAYMENT_RECEIVABLE_SOURCE: 'test_fixture', MSG91_AUTHKEY: 'fake', MSG91_INTEGRATED_NUMBER: '910000000000',
});
const { sendManualRemindersNow, sendNowSchema } = await import('./manual-journeys.js');

const inAnHour = new Date(Date.now() + 3_600_000).toISOString();
const rows = [
  { id: 1, invoice_id: 11, status: 'active', next_action_at: inAnHour },
  { id: 2, invoice_id: 12, status: 'resolved', next_action_at: null },
  { id: 3, invoice_id: 13, status: 'active', next_action_at: new Date(Date.now() - 1000).toISOString() },
  { id: 4, invoice_id: 14, status: 'active', next_action_at: inAnHour },
  { id: 5, invoice_id: 15, status: 'active', next_action_at: null },
];

it('validates the request: whole positive ids, at most 100, nothing extra', () => {
  assert.ok(sendNowSchema.safeParse({ caseIds: [1, 2] }).success);
  for (const bad of [{ caseIds: [] }, { caseIds: [0] }, { caseIds: [1.5] }, { caseIds: Array.from({ length: 101 }, (_, i) => i + 1) }, { caseIds: [1], extra: true }]) {
    assert.equal(sendNowSchema.safeParse(bad).success, false);
  }
});

it('brings only waiting, active, manually started journeys forward; never sends directly', async (t) => {
  const patched: string[] = [];
  const http = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (url.pathname.includes('msg91') || url.hostname !== '127.0.0.1') throw new Error('Send-now must not call a provider');
    if (method === 'GET' && url.pathname.endsWith('/payment_follow_up_cases')) return Response.json(rows);
    if (method === 'GET' && url.pathname.endsWith('/invoice_receivables')) {
      // Case 4's invoice is a legacy (not manual) journey.
      return Response.json([11, 12, 13, 15].map(id => ({ invoice_id: id, raw_data: { manual_payment_journey: true } })).concat([{ invoice_id: 14, raw_data: {} as never }]));
    }
    if (method === 'PATCH' && url.pathname.endsWith('/payment_follow_up_cases')) {
      patched.push(url.search);
      return Response.json([{ id: 1 }]);
    }
    if (method === 'POST' && url.pathname.endsWith('/audit_logs')) return new Response(null, { status: 201 });
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  });
  try {
    const result = await sendManualRemindersNow([1, 2, 3, 4, 5, 6, 1], 'tester');
    assert.deepEqual(result.queued, [1]);
    assert.deepEqual(result.skipped.map(item => item.caseId).sort(), [2, 3, 4, 5, 6]);
    assert.equal(patched.length, 1);
    assert.match(patched[0]!, /id=eq\.1/);
    assert.match(patched[0]!, /status=eq\.active/);
    assert.match(patched[0]!, /next_action_at=gt\./);
  } finally { http.mock.restore(); }
});

it('a click that loses the race (journey paid or already due) is reported, not retried', async (t) => {
  const http = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    if (method === 'GET' && url.pathname.endsWith('/payment_follow_up_cases')) return Response.json([rows[0]]);
    if (method === 'GET' && url.pathname.endsWith('/invoice_receivables')) return Response.json([{ invoice_id: 11, raw_data: { manual_payment_journey: true } }]);
    if (method === 'PATCH') return Response.json([]);
    throw new Error(`Unexpected request ${method} ${url.pathname}`);
  });
  try {
    const result = await sendManualRemindersNow([1], 'tester');
    assert.deepEqual(result.queued, []);
    assert.equal(result.skipped[0]!.caseId, 1);
  } finally { http.mock.restore(); }
});
