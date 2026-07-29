import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { msg91Timestamp, normalizeMsg91Status } from './msg91-status.js';

describe('MSG91 delivery status normalization', () => {
  it('maps progressive and failure delivery states', () => {
    assert.equal(normalizeMsg91Status('sent'), 'sent');
    assert.equal(normalizeMsg91Status('delivered'), 'delivered');
    assert.equal(normalizeMsg91Status('read'), 'read');
    assert.equal(normalizeMsg91Status('undelivered'), 'failed');
    assert.equal(normalizeMsg91Status('unknown'), null);
  });

  it('converts MSG91 India-local timestamps to UTC', () => {
    assert.equal(
      msg91Timestamp({ value: '2026-07-28T21:16:38' }),
      '2026-07-28T15:46:38.000Z',
    );
    assert.equal(msg91Timestamp(null), '');
  });
});
