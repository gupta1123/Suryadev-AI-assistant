import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { paymentDetailsForStorage, paymentDetailsSchema } from './payment-details.js';

describe('optional payment details', () => {
  it('accepts an empty form without storing empty values', () => {
    const parsed = paymentDetailsSchema.parse({
      paymentDate: '',
      paymentMethod: '',
      referenceNumber: '   ',
      notes: '',
    });
    assert.deepEqual(paymentDetailsForStorage(parsed), {});
  });

  it('normalizes entered payment information for the audit record', () => {
    const parsed = paymentDetailsSchema.parse({
      paymentDate: '2026-10-03',
      paymentMethod: 'bank_transfer',
      referenceNumber: '  UTR-12345  ',
      notes: '  Received in the current account.  ',
    });
    assert.deepEqual(paymentDetailsForStorage(parsed), {
      payment_date: '2026-10-03',
      payment_method: 'bank_transfer',
      reference_number: 'UTR-12345',
      notes: 'Received in the current account.',
    });
  });

  it('rejects invalid dates and unsupported methods', () => {
    assert.equal(paymentDetailsSchema.safeParse({ paymentDate: '2026-02-30' }).success, false);
    assert.equal(paymentDetailsSchema.safeParse({ paymentDate: '2999-01-01' }).success, false);
    assert.equal(paymentDetailsSchema.safeParse({ paymentMethod: 'crypto' }).success, false);
  });
});
