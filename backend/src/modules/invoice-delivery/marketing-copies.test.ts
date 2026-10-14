import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { buildMarketingCopyPayload } from './marketing-copies.js';
import { buildMsg91InvoicePayload, buildMsg91PaymentReminderPayload } from './msg91-client.js';

describe('independent marketing manager copies', () => {
  const recipient = '919445029682';
  for (const templateName of ['share_invoice', 'share_invoice_with_buttons_v2', 'share_invoice_without_buttons_v1', 'share_invoice_cancellation_v3', 'share_return_credit_memo_v3', 'share_credit_memo_v2', 'share_debit_memo_v2']) {
    it(`preserves the complete ${templateName} payload except recipient`, () => {
      const original = buildMsg91InvoicePayload({
        templateName, templateLanguage: 'en', parameterFormat: templateName === 'share_invoice' ? 'named' : 'positional',
        recipient: '917019339764', documentUrl: 'https://example.test/invoice.pdf?token=test',
        documentFileName: 'invoice.pdf', customerName: 'Customer One', billingDocument: '9001',
        billingDocumentDate: '13 Oct 2026', formattedAmount: '12,992.00', teamName: 'SuryaDev',
      });
      const snapshot = structuredClone(original);
      const copy = buildMarketingCopyPayload(original, recipient)!;
      assert.deepEqual(copy.payload.template.to_and_components[0]!.to, [recipient]);
      copy.payload.template.to_and_components[0]!.to = ['917019339764'];
      assert.deepEqual(copy, original);
      assert.deepEqual(original, snapshot);
    });
  }
  it('copies a payment reminder without adding media or changing customer values', () => {
    const original = buildMsg91PaymentReminderPayload({ recipient: '917019339764', customerName: 'Customer One', outstandingAmount: '500.00', billingDocument: '9001', billingDocumentDate: '13 Oct 2026', teamName: 'SuryaDev' });
    const copy = buildMarketingCopyPayload(original, recipient)!;
    assert.equal(copy.payload.template.to_and_components[0]!.components.header_1, undefined);
    assert.equal(copy.payload.template.to_and_components[0]!.components.body_1!.value, 'Customer One');
    assert.deepEqual(copy.payload.template.to_and_components[0]!.to, [recipient]);
  });
  it('does not send a duplicate if the manager is already the original recipient', () => {
    const payload = buildMsg91PaymentReminderPayload({ recipient, customerName: 'Customer One', outstandingAmount: '500.00', billingDocument: '9001', billingDocumentDate: '13 Oct 2026', teamName: 'SuryaDev' });
    assert.equal(buildMarketingCopyPayload(payload, recipient), null);
  });
  it('rejects an invalid manager number', () => {
    assert.throws(() => buildMarketingCopyPayload({}, 'invalid'), /Invalid marketing copy recipient/);
  });
});
