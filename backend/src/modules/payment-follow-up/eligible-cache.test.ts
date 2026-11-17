import assert from 'node:assert/strict';
import { it } from 'node:test';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH:'/dev/null', SUPABASE_URL:'http://127.0.0.1:1',SUPABASE_SERVICE_ROLE_KEY:'fake-only',
  CUSTOMER_APPROVAL_MODE:'dashboard',DELIVERY_MODE:'test',TMT_MATERIAL_CONTROL_MODE:'dashboard',SAP_TMT_MATERIAL_IDS:'30000123',
  SAP_API_BASE_URL:'http://127.0.0.1:2/sap/opu/odata/sap',SAP_API_USERNAME:'fake',SAP_API_PASSWORD:'fake',SAP_EXPECTED_HOST:'127.0.0.1',
  WHATSAPP_TEST_RECIPIENTS:'917019339764',PAYMENT_TEST_RECIPIENTS:'917019339764',
});
const { listEligiblePaymentInvoices, clearEligiblePaymentCache } = await import('./manual-journeys.js');

// Counts how many times the list was rebuilt by counting reads of the invoice table.
function mockBackend(t: { mock: { method: typeof import('node:test').mock.method } }, gate?: Promise<void>) {
  let builds = 0;
  const http = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0]) => {
    const path = new URL(String(input)).pathname;
    if (path.includes('customer_messaging_settings')) return Response.json([]);
    if (path.includes('system_settings')) return Response.json({ settings: { payment_reminders: { dueDays: 8, firstReminderDelaySeconds: 120, repeatReminderDelaySeconds: 86400, maximumReminders: 10 }, tmt_material_controls: { version: 1, materials: {} } } });
    if (path.endsWith('/customers')) return Response.json([]);
    if (path.endsWith('/invoices')) { builds += 1; if (gate) await gate; return Response.json([]); }
    throw new Error('Unexpected request: ' + path);
  });
  return { http, builds: () => builds };
}

it('reuses a recent eligible list, and rebuilds it once the cache is cleared', async (t) => {
  clearEligiblePaymentCache();
  const backend = mockBackend(t);
  try {
    await listEligiblePaymentInvoices();
    await listEligiblePaymentInvoices();
    assert.equal(backend.builds(), 1, 'second call within a minute reuses the first list');
    clearEligiblePaymentCache();
    await listEligiblePaymentInvoices();
    assert.equal(backend.builds(), 2, 'after clearing, the list is rebuilt');
  } finally { backend.http.mock.restore(); clearEligiblePaymentCache(); }
});

it('a rebuild that began before the cache was cleared is not stored', async (t) => {
  clearEligiblePaymentCache();
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const backend = mockBackend(t, gate);
  try {
    const slow = listEligiblePaymentInvoices(); // starts a build that waits on the gate
    await new Promise((resolve) => setTimeout(resolve, 50));
    clearEligiblePaymentCache(); // settings were saved while it was running
    release();
    await slow;
    await listEligiblePaymentInvoices();
    assert.equal(backend.builds(), 2, 'the outdated list was thrown away, so the next call rebuilds');
  } finally { backend.http.mock.restore(); clearEligiblePaymentCache(); }
});
