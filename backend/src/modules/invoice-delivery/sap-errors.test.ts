import assert from 'node:assert/strict';
import { it } from 'node:test';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH: '/dev/null', SUPABASE_URL: 'http://127.0.0.1:1', SUPABASE_SERVICE_ROLE_KEY: 'fake-only',
  SAP_API_BASE_URL: 'http://127.0.0.1:2/sap/opu/odata/sap', SAP_API_USERNAME: 'fake', SAP_API_PASSWORD: 'fake',
});
const { SapODataClient } = await import('./sap-client.js');

it('reports the error code of an XML failure from SAP instead of "Unknown SAP error"', async (t) => {
  const xml = '<?xml version="1.0" encoding="utf-8"?><error xmlns="http://schemas.microsoft.com/ado/2007/08/dataservices/metadata"><code>GETWA_NOT_ASSIGNED</code><message>Runtime Error</message></error>';
  const http = t.mock.method(globalThis, 'fetch', async () => new Response(xml, { status: 500 }));
  try {
    await assert.rejects(
      new SapODataClient().functionImport('API_BILLING_DOCUMENT_SRV', 'GetPDF', { BillingDocument: '26ST000038' }),
      /HTTP 500: GETWA_NOT_ASSIGNED/,
    );
  } finally { http.mock.restore(); }
});

it('keeps "Unknown SAP error" when SAP gives no readable error', async (t) => {
  const http = t.mock.method(globalThis, 'fetch', async () => new Response('Service unavailable', { status: 503 }));
  try {
    await assert.rejects(new SapODataClient().collection('API_BILLING_DOCUMENT_SRV', 'A_BillingDocument'), /HTTP 503: Unknown SAP error/);
  } finally { http.mock.restore(); }
});
