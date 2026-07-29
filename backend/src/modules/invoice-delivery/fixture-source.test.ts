import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { FixtureInvoiceSource } from './fixture-source.js';

describe('FixtureInvoiceSource', () => {
  it('normalizes SAP-shaped OData responses into one invoice candidate', async () => {
    const candidate = await new FixtureInvoiceSource().get('sap-invoice-0090000001');

    assert.equal(candidate.billingDocument, '0090000001');
    assert.equal(candidate.billingDocumentDate, '2026-07-28');
    assert.equal(candidate.customer.displayName, 'Sunrise Engineering Pvt Ltd');
    assert.equal(candidate.contact.normalizedValue, '919876543210');
    assert.equal(candidate.totalGrossAmount, 12_992);
    assert.equal(candidate.items.length, 1);
    assert.equal(Buffer.from(candidate.pdf.base64, 'base64').subarray(0, 4).toString(), '%PDF');
  });

  it('lists the fixture without exposing its raw PDF payload', async () => {
    const fixtures = await new FixtureInvoiceSource().list();
    assert.equal(fixtures.length, 1);
    assert.deepEqual(fixtures[0], {
      id: 'sap-invoice-0090000001',
      label: 'Test invoice 0090000001 — Sunrise Engineering',
      billingDocument: '0090000001',
      customerName: 'Sunrise Engineering Pvt Ltd',
      amount: 12_992,
      currency: 'INR',
    });
  });
});
