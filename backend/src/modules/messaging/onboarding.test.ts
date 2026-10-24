import assert from 'node:assert/strict';
import { after, before, describe, it, mock } from 'node:test';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: '/dev/null', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'fake-test-key',
  DELIVERY_MODE: 'test', CUSTOMER_APPROVAL_MODE: 'dashboard', SAP_ALLOWED_CUSTOMERS: '530234',
  SAP_API_BASE_URL: 'https://sap.test/sap/opu/odata/sap', SAP_API_USERNAME: 'fake', SAP_API_PASSWORD: 'fake', SAP_EXPECTED_HOST: 'sap.test',
  MSG91_MARKETING_COPY_SOURCE: 'sap', MARKETING_MANAGER_ALLOWED_RECIPIENTS: '919445029682',
  WHATSAPP_TEST_RECIPIENTS: '917019339764', ADMIN_USERNAME: 'admin', ADMIN_PASSWORD: 'admin',
});
const { app } = await import('../../app.js');
const { env } = await import('../../config/env.js');
const { assertDocumentSendAllowed } = await import('./guard.js');
const originalFetch = globalThis.fetch;
const settings = new Map<string, Record<string, unknown>>();
let server: Server;
let base = '';
let cookie = '';
let approvalWrites = 0;
let providerCalls = 0;
let livePhone = '8098868251';
let mockedFetch: ReturnType<typeof mock.method>;
const odata = (results: unknown[]) => Response.json({ d: { results } });

before(async () => {
  mockedFetch = mock.method(globalThis, 'fetch', async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
    const url = new URL(String(input));
    if (url.hostname === 'sap.test') {
      if (url.pathname.endsWith('/A_Customer')) return odata([
        { Customer: '510191', CustomerFullName: 'CASTLE BUILDERS' }, { Customer: '530234', CustomerFullName: 'Thangam Traders' },
      ]);
      if (url.pathname.endsWith('/A_BusinessPartnerAddress')) return odata([
        { BusinessPartner: '510191', AddressID: 'A' }, { BusinessPartner: '530234', AddressID: 'B' },
      ]);
      if (url.pathname.endsWith('/A_AddressPhoneNumber')) return odata([
        { AddressID: 'A', PhoneNumber: livePhone, IsDefaultPhoneNumber: true },
        { AddressID: 'B', PhoneNumber: '8098868251', IsDefaultPhoneNumber: true },
      ]);
      if (url.pathname.endsWith('/A_CustomerSalesArea')) return odata([
        { Customer: '510191', SalesOrganization: '1000', DistributionChannel: '10', Division: '01', SalesGroup: '08', SalesOffice: 'HO' },
      ]);
      if (url.pathname.endsWith('/YY1_SALESGROUP')) return odata([{ SalesGroupid: '08', SalesOffice: 'HO', MobileNo: '9445029682' }]);
    }
    if (url.origin === 'http://127.0.0.1:1') {
      if (url.pathname.endsWith('/customer_messaging_settings')) {
        if (init?.method === 'POST') {
          const row = JSON.parse(String(init.body));
          settings.set(row.sap_customer_number, { ...settings.get(row.sap_customer_number), ...row });
          approvalWrites++;
          return Response.json(settings.get(row.sap_customer_number));
        }
        const id = url.searchParams.get('sap_customer_number')?.replace(/^eq\./, '');
        return Response.json(id ? settings.get(id) ?? null : [...settings.values()]);
      }
      if (url.pathname.endsWith('/internal_test_recipients')) return Response.json([]);
      if (url.pathname.endsWith('/audit_logs')) return Response.json([]);
    }
    if (url.hostname === 'control.msg91.com') providerCalls++;
    throw new Error(`Unexpected request in isolated test: ${url.origin}${url.pathname}`);
  });
  server = app.listen(0, '127.0.0.1');
  await new Promise<void>(resolve => server.once('listening', resolve));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const login = await originalFetch(base + '/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'admin', password: 'admin' }) });
  assert.equal(login.status, 200);
  cookie = login.headers.get('set-cookie')!.split(';')[0]!;
});
after(async () => {
  mockedFetch.mock.restore();
  await new Promise<void>(resolve => server.close(() => resolve()));
  assert.equal(providerCalls, 0, 'no MSG91 calls are permitted in onboarding tests');
});

async function request(path: string, body?: unknown) {
  return originalFetch(base + path, { method: body ? 'PUT' : 'GET', headers: { cookie, 'content-type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}) });
}
const approve = (extra = {}) => request('/messaging/customers/510191/enabled', { enabled: true, expectedPhone: '918098868251', ...extra });

describe('dashboard onboarding, isolated SAP/database and no sending', () => {
  it('shows a new SAP customer as Off without writing an approval', async () => {
    const result = await request('/messaging/overview');
    assert.equal(result.status, 200);
    const { data } = await result.json() as any;
    assert.equal(data.dashboardApprovalReady, true);
    assert.equal(data.documentCutoff, '2026-10-20');
    assert.equal(data.customers.find((row: any) => row.customerNumber === '510191').status, 'not_enabled');
    assert.equal(approvalWrites, 0);
  });
  it('shows a fresh phone and shared-number warning without approving anything', async () => {
    const result = await request('/messaging/customers/510191/approval-preview');
    const { data } = await result.json() as any;
    assert.equal(data.phone, '918098868251');
    assert.equal(data.canEnable, true);
    assert.equal(data.sharedPhoneCustomers[0].customerNumber, '530234');
    assert.equal(approvalWrites, 0);
  });
  it('rejects a stale phone, missing recipient consent, or unacknowledged shared phone', async () => {
    assert.equal((await approve({ expectedPhone: '919000000000', acknowledgeRecipient: true })).status, 409);
    assert.equal((await approve()).status, 409);
    assert.equal((await approve({ acknowledgeRecipient: true })).status, 409);
    assert.equal(approvalWrites, 0);
  });
  it('approves only the chosen customer/phone, never another customer sharing it', async () => {
    const result = await approve({ acknowledgeRecipient: true, acknowledgeSharedPhone: true });
    assert.equal(result.status, 200);
    assert.equal(settings.get('510191')?.enabled, true);
    assert.equal(settings.get('510191')?.approved_phone, '918098868251');
    assert.equal(settings.has('530234'), false);
    assert.equal(approvalWrites, 1);
  });
  it('a repeated confirmation does not reset activation time', async () => {
    const before = settings.get('510191')?.enabled_at;
    assert.equal((await approve({ acknowledgeRecipient: true, acknowledgeSharedPhone: true })).status, 200);
    assert.equal(settings.get('510191')?.enabled_at, before);
    assert.equal(approvalWrites, 1);
  });
  it('rechecks the live SAP phone and blocks a changed number at dispatch', async () => {
    livePhone = '9000000000';
    try {
      await assert.rejects(assertDocumentSendAllowed({
        source: 'sap', customerNumber: '510191', recipient: '918098868251',
        documentDate: '2026-10-24', documentCreatedAt: new Date().toISOString(),
      }), /SAP phone number differs/);
      assert.equal(providerCalls, 0);
    } finally { livePhone = '8098868251'; }
  });
  it('turns off without SAP approval, and does not auto-enable after another refresh', async () => {
    assert.equal((await request('/messaging/customers/510191/enabled', { enabled: false })).status, 200);
    await request('/messaging/overview');
    assert.equal(settings.get('510191')?.enabled, false);
  });
  it('preserves the legacy server-list gate when the new mode is not enabled', async () => {
    env.CUSTOMER_APPROVAL_MODE = 'server_list';
    try { assert.equal((await approve({ acknowledgeRecipient: true, acknowledgeSharedPhone: true })).status, 403); }
    finally { env.CUSTOMER_APPROVAL_MODE = 'dashboard'; }
  });
  it('requires an authenticated administrator for preview and approval', async () => {
    assert.equal((await originalFetch(base + '/messaging/customers/510191/approval-preview')).status, 401);
    assert.equal((await originalFetch(base + '/messaging/customers/510191/enabled', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ enabled: true }) })).status, 401);
  });
});
