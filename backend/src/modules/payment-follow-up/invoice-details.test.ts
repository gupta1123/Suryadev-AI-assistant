import assert from 'node:assert/strict';
import { it } from 'node:test';

Object.assign(process.env, {
  DOTENV_CONFIG_PATH:'/dev/null', SUPABASE_URL:'http://127.0.0.1:1',SUPABASE_SERVICE_ROLE_KEY:'fake-only',
  SAP_API_BASE_URL:'http://127.0.0.1:2/sap/opu/odata/sap',SAP_API_USERNAME:'fake',SAP_API_PASSWORD:'fake',SAP_EXPECTED_HOST:'127.0.0.1',
});
const { paymentStateFromSap, daysPastDue, groupInvoiceLines } = await import('./invoice-details.js');

it('reads SAP clearing status the way the client confirmed it', () => {
  assert.equal(paymentStateFromSap({ InvoiceClearingStatus: 'A' }).state, 'not_paid');
  assert.equal(paymentStateFromSap({ InvoiceClearingStatus: 'B' }).state, 'partly_paid');
  assert.equal(paymentStateFromSap({ InvoiceClearingStatus: 'C' }).state, 'paid');
  assert.equal(paymentStateFromSap({ InvoiceClearingStatus: 'c' }).state, 'paid');
  assert.equal(paymentStateFromSap({ InvoiceClearingStatus: '' }).state, 'unknown');
  assert.equal(paymentStateFromSap({}).state, 'unknown');
});

it('a cancelled invoice is cancelled whatever its clearing status says', () => {
  assert.equal(paymentStateFromSap({ InvoiceClearingStatus: 'A', BillingDocumentIsCancelled: true }).state, 'cancelled');
  assert.equal(paymentStateFromSap({ InvoiceClearingStatus: 'C', BillingDocumentIsCancelled: 'true' }).state, 'cancelled');
  assert.equal(paymentStateFromSap({ InvoiceClearingStatus: 'A', CancelledBillingDocument: '90000001' }).state, 'cancelled');
  assert.equal(paymentStateFromSap({ InvoiceClearingStatus: 'A', BillingDocumentIsCancelled: false }).state, 'not_paid');
});

it('counts whole days past the due date, negative before it', () => {
  assert.equal(daysPastDue('2026-11-11', '2026-11-17'), 6);
  assert.equal(daysPastDue('2026-11-17', '2026-11-17'), 0);
  assert.equal(daysPastDue('2026-11-20', '2026-11-17'), -3);
});

const line = (n: string, product: string, quantity: number, net: number, batch = '') => ({ sap_item_number: n, product_id: product, description: product, quantity, quantity_unit: 'MT', net_amount: net, batch });

it('folds the zero-price batch rows into the product line above them', () => {
  const lines = groupInvoiceLines([
    line('40', '30000086', 1.005, 53767.51, 'F4-275'),
    line('10', '30000083', 1, 53500.01, 'F2-1817'),
    line('30', '30000085', 7, 374500.05),
    line('31', '30000085', 0, 0, 'F1-910'),
    line('32', '30000085', 0, 0, 'F2-1089'),
    line('33', '30000085', 0, 0, 'F2-1089'),
  ]);
  assert.deepEqual(lines.map((row) => row.number), ['10', '30', '40']);
  assert.deepEqual(lines[1]!.batches, ['F1-910', 'F2-1089'], 'batches are kept, and repeats are not listed twice');
  assert.equal(lines[1]!.quantity, 7);
  assert.equal(lines[1]!.amount, 374500.05);
  assert.deepEqual(lines[0]!.batches, ['F2-1817']);
});

it('a zero row that does not belong to the product above stays visible', () => {
  const lines = groupInvoiceLines([line('10', '30000083', 2, 1000), line('20', '30000099', 0, 0, 'X-1')]);
  assert.equal(lines.length, 2, 'a different product is never merged away');
  assert.equal(groupInvoiceLines([line('10', '30000085', 0, 0, 'F1')]).length, 1, 'a zero row with nothing above it is kept');
});
