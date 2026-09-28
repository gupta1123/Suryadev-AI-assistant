import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { paymentTestRecipients, whatsappTestRecipients } from '../../config/env.js';
import {
  assertAllowedPaymentRecipient,
  automaticPaymentCycleId,
  calculateAging,
  createPaymentReminderIdempotencyKey,
  createScheduledPaymentReminderIdempotencyKey,
  paymentDueDate,
  paymentReminderDelayMs,
  withCurrentAging,
} from './policy.js';

describe('payment follow-up safety policy', () => {
  it('allows every approved payment test number and nothing else', () => {
    for (const recipient of paymentTestRecipients) {
      assert.ok(whatsappTestRecipients.has(recipient));
      assert.doesNotThrow(() => assertAllowedPaymentRecipient(recipient));
    }
    assert.throws(
      () => assertAllowedPaymentRecipient('919999999999'),
      /outside the approved payment test numbers/,
    );
    assert.throws(() => assertAllowedPaymentRecipient(''), /outside the approved payment test numbers/);
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

  it('makes payment due 3 days after the invoice date, across month ends', () => {
    assert.equal(paymentDueDate('2026-08-04'), '2026-08-07');
    assert.equal(paymentDueDate('2026-09-29'), '2026-10-02');
    assert.equal(paymentDueDate('2026-12-30'), '2027-01-02');
    assert.throws(() => paymentDueDate('not-a-date'), /Invalid invoice date/);
  });

  it('recalculates days late from the due date instead of the stored value', () => {
    const stored = { due_date: '2026-08-07', outstanding_amount: 500, aging_bucket: 'due', days_overdue: 0 };
    assert.deepEqual(withCurrentAging(stored, '2026-08-05'), { ...stored, aging_bucket: 'upcoming', days_overdue: 0 });
    assert.deepEqual(withCurrentAging(stored, '2026-08-07'), { ...stored, aging_bucket: 'due', days_overdue: 0 });
    assert.deepEqual(withCurrentAging(stored, '2026-08-17'), { ...stored, aging_bucket: 'overdue', days_overdue: 10 });
    assert.deepEqual(withCurrentAging(stored, '2026-10-06'), { ...stored, aging_bucket: 'critical', days_overdue: 60 });
  });

  it('treats a fully paid receivable as closed no matter how old it is', () => {
    const paid = { due_date: '2026-01-01', outstanding_amount: 0 };
    assert.deepEqual(withCurrentAging(paid, '2026-09-28'), { ...paid, aging_bucket: 'closed', days_overdue: 0 });
  });

  it('uses a stable per-invoice, per-stage, per-day idempotency key', () => {
    const input = {
      billingDocument: '26SG000013',
      dueDate: '2026-08-04',
      recipient: '917019339764',
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
      recipient: '917019339764',
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
