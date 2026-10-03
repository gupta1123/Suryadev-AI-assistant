import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  formatHelpRequestAlertDateTime,
  helpRequestAlertRetryAt,
  parseHelpRequestAlertDetails,
} from './help-alerts.js';

describe('help request WhatsApp alerts', () => {
  it('formats the request time in India time', () => {
    assert.equal(
      formatHelpRequestAlertDateTime('2026-10-03T09:45:00.000Z'),
      '03 Oct 2026, 3:15 pm',
    );
  });

  it('validates and preserves the dashboard details', () => {
    const details = {
      customerName: 'Agarwal Coal',
      customerNumber: '550044',
      billingDocument: '0090000042',
      billingDocumentDate: '03 Oct 2026',
      formattedAmount: 'INR 12,992.00',
      requestedAt: '03 Oct 2026, 3:15 pm',
    };
    assert.deepEqual(parseHelpRequestAlertDetails(details), details);
    assert.throws(
      () => parseHelpRequestAlertDetails({ ...details, billingDocument: '' }),
      /billing document is missing/,
    );
  });

  it('uses bounded exponential retry delays', () => {
    const now = new Date('2026-10-03T10:00:00.000Z');
    assert.equal(helpRequestAlertRetryAt(1, now).toISOString(), '2026-10-03T10:01:00.000Z');
    assert.equal(helpRequestAlertRetryAt(4, now).toISOString(), '2026-10-03T10:08:00.000Z');
    assert.equal(helpRequestAlertRetryAt(20, now).toISOString(), '2026-10-03T11:00:00.000Z');
  });
});
