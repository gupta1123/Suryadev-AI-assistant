import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  buildMsg91InvoicePayload,
  buildMsg91PaymentReminderPayload,
  sanitizeMsg91Payload,
} from './msg91-client.js';

describe('MSG91 invoice template payload', () => {
  it('maps the approved document template variables exactly once', () => {
    const payload = buildMsg91InvoicePayload({
      recipient: '919999999999',
      documentUrl: 'https://example.test/signed-invoice.pdf?token=secret',
      documentFileName: 'invoice.pdf',
      customerName: 'Customer One',
      billingDocument: '9001',
      billingDocumentDate: '28 Jul 2026',
      formattedAmount: '12,992.00',
      teamName: 'SuryaDev',
    });
    const template = (payload.payload as Record<string, unknown>)
      .template as Record<string, unknown>;
    const target = (template.to_and_components as Record<string, unknown>[])[0]!;
    const components = target.components as Record<string, Record<string, unknown>>;

    assert.deepEqual(target.to, ['919999999999']);
    assert.equal(components.header_1?.type, 'document');
    assert.equal(components.body_var_1?.value, 'Customer One');
    assert.equal(components.body_var_4?.value, '12,992.00');
  });

  it('redacts the phone and signed URL before persistence', () => {
    const sanitized = sanitizeMsg91Payload(
      buildMsg91InvoicePayload({
        recipient: '919999999999',
        documentUrl: 'https://example.test/private.pdf?token=secret',
        documentFileName: 'invoice.pdf',
        customerName: 'Customer One',
        billingDocument: '9001',
        billingDocumentDate: '28 Jul 2026',
        formattedAmount: '12,992.00',
        teamName: 'SuryaDev',
      }),
    );
    const serialized = JSON.stringify(sanitized);
    assert.equal(serialized.includes('919999999999'), false);
    assert.equal(serialized.includes('token=secret'), false);
  });
});

describe('MSG91 payment reminder template payload', () => {
  it('maps the approved due-reminder variables without a document header', () => {
    const payload = buildMsg91PaymentReminderPayload({
      recipient: '917019339764',
      customerName: 'Sri Praveen Enterprises',
      outstandingAmount: '236.00',
      billingDocument: '26SG000013',
      billingDocumentDate: '29 Jul 2026',
      teamName: 'SuryaDev',
    });
    const template = (payload.payload as Record<string, unknown>)
      .template as Record<string, unknown>;
    const target = (template.to_and_components as Record<string, unknown>[])[0]!;
    const components = target.components as Record<string, Record<string, unknown>>;

    assert.deepEqual(target.to, ['917019339764']);
    assert.equal(components.body_1?.value, 'Sri Praveen Enterprises');
    assert.equal(components.body_2?.value, '236.00');
    assert.equal(components.body_3?.value, '26SG000013');
    assert.equal(components.header_1, undefined);
  });
});
