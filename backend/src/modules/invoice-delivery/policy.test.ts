import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FixtureInvoiceSource } from './fixture-source.js';
import {
  buildInvoicePreview,
  createDeliveryIdempotencyKey,
  formatInvoiceAmount,
  maskPhone,
} from './policy.js';

describe('invoice delivery policy', () => {
  it('renders deterministic MSG91 template variables', async () => {
    const candidate = await new FixtureInvoiceSource().get('sap-invoice-0090000001');
    const preview = buildInvoicePreview(candidate, '919999999999');

    assert.equal(preview.template.name, 'share_invoice');
    assert.equal(preview.template.variables.var_1, 'Sunrise Engineering Pvt Ltd');
    assert.equal(preview.template.variables.var_2, '0090000001');
    assert.equal(preview.template.variables.var_3, '28 Jul 2026');
    assert.equal(preview.template.variables.var_4, '12,992.00');
    assert.equal(preview.invoice.fixtureContact, '91••••••3210');
    assert.equal(preview.sendAllowed, false);
  });

  it('creates stable recipient-specific idempotency keys', async () => {
    const candidate = await new FixtureInvoiceSource().get('sap-invoice-0090000001');
    const first = createDeliveryIdempotencyKey(candidate, '919999999999');
    assert.equal(first, createDeliveryIdempotencyKey(candidate, '919999999999'));
    assert.notEqual(first, createDeliveryIdempotencyKey(candidate, '918888888888'));
    assert.equal(first.includes('919999999999'), false);
  });

  it('formats and masks values without duplicating the template currency symbol', () => {
    assert.equal(formatInvoiceAmount(12992), '12,992.00');
    assert.equal(maskPhone('919876543210'), '91••••••3210');
  });
});
