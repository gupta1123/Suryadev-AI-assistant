import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { marketingCopyListQuerySchema } from './marketing-copy-list.js';

describe('marketing manager list filters', () => {
  it('defaults to a bounded server-paginated list', () => {
    assert.deepEqual(marketingCopyListQuerySchema.parse({}), { page: 1, pageSize: 10 });
  });
  it('accepts independent copy statuses and message filters', () => {
    assert.deepEqual(marketingCopyListQuerySchema.parse({ page: '2', pageSize: '25', status: 'accepted', kind: 'reminders' }), { page: 2, pageSize: 25, status: 'accepted', kind: 'reminders' });
  });
  it('rejects unsupported customer receipt statuses and unsafe page sizes', () => {
    for (const input of [{ status: 'read' }, { status: 'delivered' }, { page: 0 }, { pageSize: 1000 }, { kind: 'other' }]) {
      assert.equal(marketingCopyListQuerySchema.safeParse(input).success, false);
    }
  });
});
