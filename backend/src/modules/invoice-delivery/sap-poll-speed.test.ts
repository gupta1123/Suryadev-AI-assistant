import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: '/dev/null', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'fake-only',
  CUSTOMER_APPROVAL_MODE: 'dashboard', DELIVERY_MODE: 'test', TMT_MATERIAL_CONTROL_MODE: 'dashboard',
  SAP_API_BASE_URL: 'http://127.0.0.1:2/sap/opu/odata/sap', SAP_API_USERNAME: 'fake', SAP_API_PASSWORD: 'fake', SAP_EXPECTED_HOST: '127.0.0.1',
});
const { earlyBlocker } = await import('./sap-poller.js');
const { findBillingDocumentsWithDeliveryJob } = await import('./repository.js');

const enabled = { sapCustomerNumber: '510191', enabled: true, approvedPhone: '918098868251', enabledAt: '2026-11-03T00:00:00.000Z',
  managerName: null, managerPhone: null, managerSource: 'sap' as const, updatedBy: null, updatedAt: null };

describe('early poll check (runs before any heavy SAP read)', () => {
  it('skips a customer who is not enabled or has no setting', () => {
    const invoice = { billingDocumentDate: '2026-11-10', creationDateTime: '2026-11-10T06:00:00.000Z' };
    assert.match(earlyBlocker(invoice, undefined) ?? '', /not enabled/);
    assert.match(earlyBlocker(invoice, { ...enabled, enabled: false }) ?? '', /not enabled/);
  });
  it('skips an invoice created before the customer was enabled, even if dated later', () => {
    const invoice = { billingDocumentDate: '2026-11-10', creationDateTime: '2026-11-02T06:00:00.000Z' };
    assert.match(earlyBlocker(invoice, enabled) ?? '', /before this customer was enabled/);
  });
  it('skips an invoice dated before the 20 Oct cutoff', () => {
    const invoice = { billingDocumentDate: '2026-10-19', creationDateTime: '2026-11-10T06:00:00.000Z' };
    assert.match(earlyBlocker(invoice, enabled) ?? '', /before 2026-10-20/);
  });
  it('lets a new invoice from an enabled customer through to the full checks', () => {
    const invoice = { billingDocumentDate: '2026-11-10', creationDateTime: '2026-11-10T06:00:00.000Z' };
    assert.equal(earlyBlocker(invoice, enabled), null);
  });
  it('leaves the decision to the full check when the list gave no dates', () => {
    assert.equal(earlyBlocker({}, enabled), null);
  });
});

describe('already delivered invoices are skipped', () => {
  it('returns only invoices that already have an invoice delivery job', async (t) => {
    const urls: string[] = [];
    const http = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      assert.equal(init?.method ?? 'GET', 'GET', 'the lookup must never write');
      urls.push(String(input));
      return Response.json([{ sap_billing_document: 'A1', communication_jobs: [{ job_type: 'invoice_delivery' }] },
        { sap_billing_document: 'A3', communication_jobs: [{ job_type: 'invoice_delivery' }] }]);
    });
    try {
      const handled = await findBillingDocumentsWithDeliveryJob(['A1', 'A2', 'A3']);
      assert.deepEqual([...handled].sort(), ['A1', 'A3']);
      assert.match(decodeURIComponent(urls[0]!), /job_type=eq\.invoice_delivery/);
    } finally { http.mock.restore(); }
  });
  it('checks in chunks so a long list still works', async (t) => {
    let calls = 0;
    const http = t.mock.method(globalThis, 'fetch', async () => { calls += 1; return Response.json([]); });
    try {
      const handled = await findBillingDocumentsWithDeliveryJob(Array.from({ length: 250 }, (_, i) => `D${i}`));
      assert.equal(handled.size, 0);
      assert.equal(calls, 3);
    } finally { http.mock.restore(); }
  });
  it('skips nothing when the lookup fails, so the old duplicate protection still decides', async (t) => {
    const http = t.mock.method(globalThis, 'fetch', async () => new Response('boom', { status: 500 }));
    const log = t.mock.method(console, 'error', () => undefined);
    try {
      assert.equal((await findBillingDocumentsWithDeliveryJob(['A1'])).size, 0);
    } finally { http.mock.restore(); log.mock.restore(); }
  });
});
