import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

// All reads and sends below are intercepted. Never load real project credentials
// or contact SAP, Supabase or MSG91 in these regression tests.
Object.assign(process.env, {
  DOTENV_CONFIG_PATH: '/dev/null',
  SUPABASE_URL: 'http://127.0.0.1:1',
  SUPABASE_SERVICE_ROLE_KEY: 'fake-unit-test-key',
  DELIVERY_MODE: 'test',
  SAP_ALLOWED_CUSTOMERS: '530234',
  WHATSAPP_TEST_RECIPIENTS: '917019339764',
  PAYMENT_TEST_RECIPIENTS: '917019339764',
  MARKETING_MANAGER_ALLOWED_RECIPIENTS: '919445029682',
  MSG91_MARKETING_COPY_SOURCE: 'manual',
});
const { assertDocumentSendAllowed, assertPaymentRecipientApproved, assertManagerCopyStillAllowed } = await import('./guard.js');
const { sendTemplatePayload } = await import('../invoice-delivery/msg91-client.js');
const { assertHelpAlertDocumentAllowed } = await import('../invoice-delivery/help-alerts.js');
const dates = { documentDate: '2026-10-20', documentCreatedAt: '2026-10-20T09:00:00Z' };

describe('fresh customer approval at dispatch (mock services only)', () => {
  for (const kind of ['invoice', 'fixture', 'reminder', 'manager'] as const) {
    it(`blocks a pre-cutoff ${kind} before any provider request`, async (t) => {
      let providerCalls = 0;
      const http = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const url = String(input);
        if (url.includes('/customer_messaging_settings')) return Response.json({
          sap_customer_number: '530234', enabled: true, approved_phone: '917019339764', enabled_at: '2026-10-19T08:00:00Z',
          manager_name: 'Manager', manager_phone: '919445029682', manager_source: 'manual', updated_by: null, updated_at: null,
        });
        if (url.includes('/internal_test_recipients')) return Response.json({ phone: '917019339764', allow_simulator: true, allow_payment_reminders: true });
        providerCalls++;
        throw new Error('No provider request expected');
      });
      const old = { documentDate: '2026-10-19', documentCreatedAt: '2026-10-24T12:00:00Z' };
      const check = () => kind === 'reminder' ? assertPaymentRecipientApproved('530234', '917019339764', old)
        : kind === 'manager' ? assertManagerCopyStillAllowed('530234', '919445029682', old)
          : assertDocumentSendAllowed({ source: kind === 'fixture' ? 'fixture' : 'sap', customerNumber: '530234', recipient: '917019339764', ...old });
      try {
        await assert.rejects(sendTemplatePayload({}, 1000, check), /dated before 2026-10-20/);
        assert.equal(providerCalls, 0);
      } finally { http.mock.restore(); }
    });
  }
  it('checks the real invoice behind an existing help alert, not its message timestamp', async (t) => {
    let providerCalls = 0;
    const http = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof globalThis.fetch>[0]) => {
      const url = String(input);
      if (url.includes('/review_tasks')) return Response.json({ invoice_id: 12 });
      if (url.includes('/invoices')) return Response.json({ billing_document_date: '2026-10-19', creation_datetime: '2026-10-24T12:00:00Z' });
      providerCalls++;
      throw new Error('No provider request expected');
    });
    try {
      await assert.rejects(sendTemplatePayload({}, 1000, () => assertHelpAlertDocumentAllowed(1)), /dated before 2026-10-20/);
      assert.equal(providerCalls, 0);
    } finally { http.mock.restore(); }
  });
  for (const kind of ['invoice', 'fixture', 'reminder', 'manager'] as const) {
    it(`blocks a queued ${kind} when disabled after its first check`, async (t) => {
      let enabled = true;
      let settingReads = 0;
      let providerCalls = 0;
      const http = t.mock.method(globalThis, 'fetch', async (input: Parameters<typeof globalThis.fetch>[0]) => {
        const url = String(input);
        if (url.includes('/rest/v1/customer_messaging_settings')) {
          settingReads++;
          return Response.json({
            sap_customer_number: '530234', enabled,
            approved_phone: '917019339764', enabled_at: '2026-10-20T08:00:00Z',
            manager_name: 'Manager', manager_phone: '919445029682', manager_source: 'manual',
            updated_by: null, updated_at: null,
          });
        }
        if (url.includes('/rest/v1/internal_test_recipients')) {
          return Response.json({
            phone: '917019339764', label: 'Test', allow_simulator: true,
            allow_payment_reminders: true, updated_by: null, updated_at: null,
          });
        }
        if (url.includes('whatsapp-outbound-message')) {
          providerCalls++;
          return Response.json({});
        }
        throw new Error(`Unexpected test request: ${url}`);
      });
      const check = () => kind === 'reminder'
        ? assertPaymentRecipientApproved('530234', '917019339764', dates)
        : kind === 'manager'
          ? assertManagerCopyStillAllowed('530234', '919445029682', dates)
          : assertDocumentSendAllowed({
            source: kind === 'fixture' ? 'fixture' : 'sap',
            customerNumber: '530234', recipient: '917019339764',
            documentCreatedAt: '2026-10-20T09:00:00Z',
            documentDate: '2026-10-20',
          });
      try {
        await check();
        enabled = false; // Simulate a saved switch change while the job prepares.
        await assert.rejects(sendTemplatePayload({}, 1000, check), /not enabled/);
        assert.ok(settingReads >= 2, 'dispatch must re-read approval, not reuse a cached snapshot');
        assert.equal(providerCalls, 0);
      } finally {
        http.mock.restore();
      }
    });
  }

  it('refuses reminders if the customer approval read fails', async (t) => {
    const http = t.mock.method(globalThis, 'fetch', async () => Response.json(
      { message: 'approval read unavailable' }, { status: 400 },
    ));
    try {
      await assert.rejects(assertPaymentRecipientApproved('530234', '917019339764', dates), /Unable to read/);
    } finally {
      http.mock.restore();
    }
  });
});
