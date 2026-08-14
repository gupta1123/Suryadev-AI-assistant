import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  assertHardPaymentRecipient,
  automaticPaymentCycleId,
  calculateAging,
  createPaymentReminderIdempotencyKey,
  createScheduledPaymentReminderIdempotencyKey,
  paymentReminderDelayMs,
  PAYMENT_HARD_TEST_RECIPIENT,
} from './policy.js';

describe('payment follow-up safety policy', () => {
  it('allows only the explicitly approved test recipient', () => {
    assert.doesNotThrow(() => assertHardPaymentRecipient(PAYMENT_HARD_TEST_RECIPIENT));
    assert.throws(
      () => assertHardPaymentRecipient('919999999999'),
      /outside the single controlled test number/,
    );
  });

  it('uses the first delay once and the repeat delay afterwards', () => {
    assert.equal(paymentReminderDelayMs(0, 60, 10), 60_000);
    assert.equal(paymentReminderDelayMs(1, 60, 10), 10_000);
    assert.equal(paymentReminderDelayMs(2, 60, 10), 10_000);
  });

  it('creates a deterministic automatic cycle for an invoice delivery job', () => {
    assert.equal(automaticPaymentCycleId(42), 'automatic-invoice-job-42');
    assert.throws(() => automaticPaymentCycleId(0), /Invalid invoice job identifier/);
  });

  it('classifies a receivable due today without overdue days', () => {
    assert.deepEqual(calculateAging('2026-08-04', 236, '2026-08-04'), {
      bucket: 'due',
      daysOverdue: 0,
    });
  });

  it('uses a stable per-invoice, per-stage, per-day idempotency key', () => {
    const input = {
      billingDocument: '26SG000013',
      dueDate: '2026-08-04',
      recipient: PAYMENT_HARD_TEST_RECIPIENT,
      stageCode: 'due_today',
    };
    assert.equal(
      createPaymentReminderIdempotencyKey(input),
      createPaymentReminderIdempotencyKey(input),
    );
    assert.notEqual(
      createPaymentReminderIdempotencyKey(input),
      createPaymentReminderIdempotencyKey({ ...input, dueDate: '2026-08-05' }),
    );
  });

  it('creates a stable but distinct key for each scheduled reminder slot', () => {
    const input = {
      billingDocument: '26SG000013',
      scheduledFor: '2026-08-04T09:29:00.000Z',
      recipient: PAYMENT_HARD_TEST_RECIPIENT,
      reminderNumber: 2,
    };
    assert.equal(
      createScheduledPaymentReminderIdempotencyKey(input),
      createScheduledPaymentReminderIdempotencyKey(input),
    );
    assert.notEqual(
      createScheduledPaymentReminderIdempotencyKey(input),
      createScheduledPaymentReminderIdempotencyKey({ ...input, reminderNumber: 3 }),
    );
  });
});
